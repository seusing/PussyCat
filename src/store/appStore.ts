import { create } from 'zustand'
import type { CommandManifest } from '../data/types'
import type { OutputEvent, DoneEvent } from '../host/types'
import type { PolicyDecision } from '../data/policy'
import { transition, type RunState } from './runMachine'
import {
  emptyPreferences, loadPreferences, savePreferences,
  toggleFavoriteSite, toggleFavoriteCommand, restoreFavoriteSite, restoreFavoriteCommand,
  pushRecent, staleKeys, acknowledge, revokeAcknowledgement,
  type PreferencesSnapshot, type FavoriteSite, type FavoriteCommand,
} from '../data/preferences'

const SENSITIVE = /password|passcode|secret|token|cookie/i

// cmd 暂未参与判定（脱敏仅按字段名正则），但按 brief 接口签名保留形参供未来按 arg 类型细化
export function redactValues(_cmd: CommandManifest, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) out[k] = SENSITIVE.test(k) && !!v ? '••••' : v
  return out
}

export type CommandRun = {
  id: string
  command: CommandManifest
  values: Record<string, unknown>          // 已脱敏
  state: RunState
  startedAt: number
  endedAt?: number
  lines: OutputEvent[]
  result?: Record<string, unknown>[]
  error?: { summary: string; detail?: string }
}

export type LastUndo =
  | { kind: 'site'; item: FavoriteSite }
  | { kind: 'command'; item: FavoriteCommand }

function defaultsOf(cmd: CommandManifest): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const a of cmd.args) if (a.default !== undefined) v[a.name] = a.default
  return v
}

export function isTerminal(s: RunState): boolean {
  return s === 'succeeded' || s === 'failed' || s === 'cancelled'
}

// 刷新后 selection 校正(块 B 阻塞3):A 同 key→新 manifest+活值∩新参数保留+新参补默认;
// B key 删→清空;currentRun 永不改写(历史运行快照)
function reconcileSelection(
  selected: CommandManifest | undefined,
  values: Record<string, unknown>,
  commands: CommandManifest[],
): { selected?: CommandManifest; values: Record<string, unknown> } {
  if (!selected) return { selected: undefined, values: {} }
  const next = commands.find((c) => c.command === selected.command)
  if (!next) return { selected: undefined, values: {} }
  const merged = defaultsOf(next)
  const argNames = new Set(next.args.map((a) => a.name))
  for (const [k, v] of Object.entries(values)) if (argNames.has(k)) merged[k] = v
  return { selected: next, values: merged }
}

type AppState = {
  commands: CommandManifest[]
  setCommands: (cmds: CommandManifest[], decisions?: PolicyDecision[]) => void
  // Host 逐命令判决(I-P1):前端不持有任何准入规则,只存、只读。未连接/降级时为空 Map。
  decisions: Map<string, PolicyDecision>
  decisionFor: (commandKey: string) => PolicyDecision | undefined
  catalogStatus: 'loading' | 'ready' | 'error'
  catalogError?: string
  setCatalogStatus: (status: 'loading' | 'ready' | 'error', error?: string) => void
  selected?: CommandManifest
  values: Record<string, unknown>
  selectCommand: (cmd: CommandManifest) => void
  setValue: (name: string, value: unknown) => void
  currentRun?: CommandRun
  beginRun: (runId: string) => void
  appendOutput: (e: OutputEvent) => void
  finishRun: (e: DoneEvent) => void
  markCancelling: () => void
  runPanelCollapsed: boolean
  setRunPanelCollapsed: (v: boolean) => void
  mode: 'demo' | 'connected'
  setMode: (mode: 'demo' | 'connected') => void
  // —— preferences 切片 ——
  preferences: PreferencesSnapshot
  stale: { sites: Set<string>; commands: Set<string> }
  lastUndo?: LastUndo
  hydratePreferences: () => void
  toggleSiteFavorite: (site: string) => void
  toggleCommandFavorite: (cmd: CommandManifest) => void
  undoLastFavorite: () => void
  dismissUndo: () => void
  // —— acknowledgement 切片(Task 8):Host 判 acknowledgement-required 时,前端要求用户确认一次并绑定 fingerprint。
  // acknowledgement 本身不是安全授权(I-P5)——它只防误点/陈旧 UI,执行边界仍由 Host 的 denied/unknown 拒绝把守。
  pendingAcknowledgement?: { command: CommandManifest; decision: PolicyDecision }
  requestAcknowledgement: (command: CommandManifest, decision: PolicyDecision) => void
  dismissAcknowledgement: () => void
  // 返回是否真正持久化(false = 仅本次会话有效,storage 写入失败时仍要放行内存态确认)
  acknowledgeCommand: (commandKey: string, fingerprint: string, now?: number) => boolean
  revokeAcknowledgementCommand: (commandKey: string) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  commands: [],
  setCommands: (commands, decisions) => set((s) => ({
    commands, catalogStatus: 'ready', catalogError: undefined,
    decisions: new Map((decisions ?? []).map((d) => [d.commandKey, d])),
    stale: staleKeys(s.preferences, commands),
    ...reconcileSelection(s.selected, s.values, commands),
  })),
  decisions: new Map(),
  decisionFor: (commandKey) => get().decisions.get(commandKey),
  catalogStatus: 'loading',
  catalogError: undefined,
  setCatalogStatus: (status, error) => set({ catalogStatus: status, catalogError: error }),
  selected: undefined,
  values: {},
  selectCommand: (cmd) => set({ selected: cmd, values: defaultsOf(cmd) }),
  setValue: (name, value) => set((s) => ({ values: { ...s.values, [name]: value } })),
  currentRun: undefined,
  beginRun: (runId) => {
    const cmd = get().selected
    if (!cmd) return
    const preferences = pushRecent(get().preferences, cmd.command, Date.now())
    savePreferences(preferences)
    set({
      preferences,
      runPanelCollapsed: false,
      currentRun: {
        id: runId, command: cmd, values: redactValues(cmd, get().values),
        state: transition(transition('idle', { type: 'RUN' }), { type: 'VALID' }), // →starting
        startedAt: Date.now(), lines: [],
      },
    })
  },
  appendOutput: (e) => set((s) => {
    if (!s.currentRun || s.currentRun.id !== e.runId || isTerminal(s.currentRun.state)) return s
    const lines = s.currentRun.lines
    const last = lines[lines.length - 1]
    // 快路径:seq 单调(P0-B 硬前提#3)时免 some/sort——数组恒有序,尾后新 seq 不可能重复。
    // 口径:剔除 some/sort 的常数优化(基准 8-13×@≤10k,spec §4),渐近仍 O(n²) 复制;不可变约定保留。
    let next: OutputEvent[]
    if (!last || e.seq > last.seq) {
      next = [...lines, e]
    } else if (lines.some((l) => l.seq === e.seq)) {
      return s
    } else {
      next = [...lines, e].sort((a, b) => a.seq - b.seq)
    }
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'OUTPUT' }), lines: next } }
  }),
  finishRun: (e) => set((s) => {
    if (!s.currentRun || s.currentRun.id !== e.runId || isTerminal(s.currentRun.state)) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'DONE', outcome: e.outcome }), endedAt: e.at, result: e.result, error: e.error } }
  }),
  markCancelling: () => set((s) => {
    if (!s.currentRun) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'CANCEL' }) } }
  }),
  runPanelCollapsed: false,
  setRunPanelCollapsed: (v) => set({ runPanelCollapsed: v }),
  mode: 'demo',
  setMode: (mode) => set({ mode }),
  // —— preferences 切片 ——
  preferences: emptyPreferences(),
  stale: { sites: new Set<string>(), commands: new Set<string>() },
  lastUndo: undefined,
  hydratePreferences: () => set((s) => {
    const preferences = loadPreferences()
    return { preferences, stale: staleKeys(preferences, s.commands), lastUndo: undefined }
  }),
  toggleSiteFavorite: (site) => set((s) => {
    const removed = s.preferences.favoriteSites.find((f) => f.site === site)
    const preferences = toggleFavoriteSite(s.preferences, site, Date.now())
    savePreferences(preferences)
    return { preferences, stale: staleKeys(preferences, s.commands), lastUndo: removed ? { kind: 'site', item: removed } : undefined }
  }),
  toggleCommandFavorite: (cmd) => set((s) => {
    const removed = s.preferences.favoriteCommands.find((f) => f.command === cmd.command)
    const preferences = toggleFavoriteCommand(s.preferences, cmd.command, cmd.site, Date.now())
    savePreferences(preferences)
    return { preferences, stale: staleKeys(preferences, s.commands), lastUndo: removed ? { kind: 'command', item: removed } : undefined }
  }),
  undoLastFavorite: () => set((s) => {
    const u = s.lastUndo
    if (!u) return s
    const preferences = u.kind === 'site'
      ? restoreFavoriteSite(s.preferences, u.item)
      : restoreFavoriteCommand(s.preferences, u.item)
    savePreferences(preferences)
    return { preferences, stale: staleKeys(preferences, s.commands), lastUndo: undefined }
  }),
  dismissUndo: () => set({ lastUndo: undefined }),
  // —— acknowledgement 切片 ——
  pendingAcknowledgement: undefined,
  requestAcknowledgement: (command, decision) => set({ pendingAcknowledgement: { command, decision } }),
  dismissAcknowledgement: () => set({ pendingAcknowledgement: undefined }),
  acknowledgeCommand: (commandKey, fingerprint, now = Date.now()) => {
    const preferences = acknowledge(get().preferences, commandKey, fingerprint, now)
    const persisted = savePreferences(preferences)
    set({ preferences })   // 内存态无条件更新:即便 persisted=false,本次会话仍视为已确认(IO 边界降级)
    return persisted
  },
  revokeAcknowledgementCommand: (commandKey) => set((s) => {
    const preferences = revokeAcknowledgement(s.preferences, commandKey)
    savePreferences(preferences)
    return { preferences }
  }),
}))
