import { create } from 'zustand'
import type { CommandManifest } from '../data/types'
import type { OutputEvent, DoneEvent } from '../host/types'
import { transition, type RunState } from './runMachine'
import {
  emptyPreferences, loadPreferences, savePreferences,
  toggleFavoriteSite, toggleFavoriteCommand, isSiteFavorited, isCommandFavorited,
  pushRecent, staleKeys, type PreferencesSnapshot,
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
  | { kind: 'site'; site: string }
  | { kind: 'command'; command: string; site: string }

function defaultsOf(cmd: CommandManifest): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const a of cmd.args) if (a.default !== undefined) v[a.name] = a.default
  return v
}

function isTerminal(s: RunState): boolean {
  return s === 'succeeded' || s === 'failed' || s === 'cancelled'
}

type AppState = {
  commands: CommandManifest[]
  setCommands: (cmds: CommandManifest[]) => void
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
  mode: 'demo' | 'connected'
  setMode: (mode: 'demo' | 'connected') => void
  // —— preferences 切片 ——
  preferences: PreferencesSnapshot
  stale: { sites: Set<string>; commands: Set<string> }
  lastUndo?: LastUndo
  hydratePreferences: () => void
  toggleSiteFavorite: (site: string) => void
  toggleCommandFavorite: (cmd: CommandManifest) => void
  reconcilePreferences: () => void
  undoLastFavorite: () => void
  dismissUndo: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  commands: [],
  setCommands: (commands) => set((s) => ({
    commands, catalogStatus: 'ready', catalogError: undefined,
    stale: staleKeys(s.preferences, commands),
  })),
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
      currentRun: {
        id: runId, command: cmd, values: redactValues(cmd, get().values),
        state: transition(transition('idle', { type: 'RUN' }), { type: 'VALID' }), // →starting
        startedAt: Date.now(), lines: [],
      },
    })
  },
  appendOutput: (e) => set((s) => {
    if (!s.currentRun || s.currentRun.id !== e.runId || isTerminal(s.currentRun.state)) return s
    if (s.currentRun.lines.some((l) => l.seq === e.seq)) return s
    const lines = [...s.currentRun.lines, e].sort((a, b) => a.seq - b.seq)
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'OUTPUT' }), lines } }
  }),
  finishRun: (e) => set((s) => {
    if (!s.currentRun || s.currentRun.id !== e.runId || isTerminal(s.currentRun.state)) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'DONE', outcome: e.outcome }), endedAt: e.at, result: e.result, error: e.error } }
  }),
  markCancelling: () => set((s) => {
    if (!s.currentRun) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'CANCEL' }) } }
  }),
  mode: 'demo',
  setMode: (mode) => set({ mode }),
  // —— preferences 切片 ——
  preferences: emptyPreferences(),
  stale: { sites: new Set<string>(), commands: new Set<string>() },
  lastUndo: undefined,
  hydratePreferences: () => set((s) => {
    const preferences = loadPreferences()
    return { preferences, stale: staleKeys(preferences, s.commands) }
  }),
  toggleSiteFavorite: (site) => set((s) => {
    const wasFav = isSiteFavorited(s.preferences, site)
    const preferences = toggleFavoriteSite(s.preferences, site, Date.now())
    savePreferences(preferences)
    return { preferences, stale: staleKeys(preferences, s.commands), lastUndo: wasFav ? { kind: 'site', site } : undefined }
  }),
  toggleCommandFavorite: (cmd) => set((s) => {
    const wasFav = isCommandFavorited(s.preferences, cmd.command)
    const preferences = toggleFavoriteCommand(s.preferences, cmd.command, cmd.site, Date.now())
    savePreferences(preferences)
    return { preferences, stale: staleKeys(preferences, s.commands), lastUndo: wasFav ? { kind: 'command', command: cmd.command, site: cmd.site } : undefined }
  }),
  reconcilePreferences: () => set((s) => ({ stale: staleKeys(s.preferences, s.commands) })),
  undoLastFavorite: () => set((s) => {
    const u = s.lastUndo
    if (!u) return s
    const preferences = u.kind === 'site'
      ? toggleFavoriteSite(s.preferences, u.site, Date.now())
      : toggleFavoriteCommand(s.preferences, u.command, u.site, Date.now())
    savePreferences(preferences)
    return { preferences, stale: staleKeys(preferences, s.commands), lastUndo: undefined }
  }),
  dismissUndo: () => set({ lastUndo: undefined }),
}))
