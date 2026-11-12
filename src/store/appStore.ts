import { create } from 'zustand'
import type { CommandManifest } from '../data/types'
import type { OutputEvent, DoneEvent } from '../host/types'
import type { PolicyDecision } from '../data/policy'
import type { LoginCheckEntry, LoginCheckState } from '../data/loginStatus'
import { transition, type RunState } from './runMachine'
import {
  emptyPreferences, loadPreferences, savePreferences,
  pushRecent, staleKeys, acknowledge, revokeAcknowledgement,
  type PreferencesSnapshot,
} from '../data/preferences'

const SENSITIVE = /password|passcode|secret|token|cookie/i

/** 导航里的三个固定分组 + 「全部站点」。 */
export type NavSectionKey = 'recent' | 'favSites' | 'favCommands' | 'allSites'

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

/** 一个命令标签页:命令、表单值、最近一次运行。同一条命令只会有一个标签页。 */
export type CommandTab = { command: CommandManifest; values: Record<string, unknown>; run?: CommandRun }

/** 用户手动发起的命令同时在跑的上限。Host 的 maxConcurrentRuns(server/run-manager-options.mjs)= 它 + 后台体检并发。 */
export const MANUAL_RUN_CONCURRENCY = 3

type TabFields = Pick<AppState, 'selected' | 'values' | 'currentRun' | 'backgroundTabs' | 'activeTabSlot'>

/** 标签栏的完整列表:当前标签插在 backgroundTabs 的 activeTabSlot 位置。 */
export function commandTabs(s: TabFields): CommandTab[] {
  if (!s.selected) return s.backgroundTabs
  const tabs = s.backgroundTabs.slice()
  tabs.splice(Math.min(s.activeTabSlot, tabs.length), 0, { command: s.selected, values: s.values, run: s.currentRun })
  return tabs
}

/** 当前 + 后台标签里还没到终态的运行数。 */
export function activeRunCount(s: Pick<AppState, 'currentRun' | 'backgroundTabs'>): number {
  let count = s.currentRun && !isTerminal(s.currentRun.state) ? 1 : 0
  for (const tab of s.backgroundTabs) if (tab.run && !isTerminal(tab.run.state)) count += 1
  return count
}

/** 把 tabs[index] 提成当前标签,其余顺序不变;activeTabSlot 落在它原来的显示位置。 */
function activateTab(tabs: CommandTab[], index: number) {
  const tab = tabs[index]
  return {
    selected: tab.command,
    values: tab.values,
    currentRun: tab.run,
    backgroundTabs: tabs.filter((_, i) => i !== index),
    activeTabSlot: index,
  }
}

/** 当前标签没了:右邻优先、无则左邻;一个邻居都没有就清空。slot 是当前标签原来在 background 里的插入位。 */
function activateNeighbor(background: CommandTab[], slot: number) {
  const index = slot < background.length ? slot : slot - 1
  if (index < 0) return { selected: undefined, values: {}, currentRun: undefined, backgroundTabs: [], activeTabSlot: 0 }
  return activateTab(background, index)
}

function applyOutput(run: CommandRun, e: OutputEvent): CommandRun | null {
  if (run.id !== e.runId || isTerminal(run.state)) return null
  const lines = run.lines
  const last = lines[lines.length - 1]
  // 快路径:seq 单调(P0-B 硬前提#3)时免 some/sort——数组恒有序,尾后新 seq 不可能重复。
  // 口径:剔除 some/sort 的常数优化(基准 8-13×@≤10k,spec §4),渐近仍 O(n²) 复制;不可变约定保留。
  let next: OutputEvent[]
  if (!last || e.seq > last.seq) {
    next = [...lines, e]
  } else if (lines.some((l) => l.seq === e.seq)) {
    return null
  } else {
    next = [...lines, e].sort((a, b) => a.seq - b.seq)
  }
  return { ...run, state: transition(run.state, { type: 'OUTPUT' }), lines: next }
}

function applyDone(run: CommandRun, e: DoneEvent): CommandRun | null {
  if (run.id !== e.runId || isTerminal(run.state)) return null
  return { ...run, state: transition(run.state, { type: 'DONE', outcome: e.outcome }), endedAt: e.at, result: e.result, error: e.error }
}

// 事件按 runId 找到所属的运行:先看当前标签,否则在后台标签里找。update 返回 null 表示不改。
function patchRun(
  s: Pick<AppState, 'currentRun' | 'backgroundTabs'>,
  runId: string,
  update: (run: CommandRun) => CommandRun | null,
): Pick<AppState, 'currentRun'> | Pick<AppState, 'backgroundTabs'> | null {
  if (s.currentRun?.id === runId) {
    const run = update(s.currentRun)
    return run ? { currentRun: run } : null
  }
  const index = s.backgroundTabs.findIndex((tab) => tab.run?.id === runId)
  if (index < 0) return null
  const run = update(s.backgroundTabs[index].run!)
  if (!run) return null
  const backgroundTabs = s.backgroundTabs.slice()
  backgroundTabs[index] = { ...backgroundTabs[index], run }
  return { backgroundTabs }
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
  // selected / values / currentRun 是**当前标签页**。其余标签页放 backgroundTabs(按标签栏顺序),
  // activeTabSlot 是当前标签插在其中的位置 —— 完整列表见 commandTabs(),只有这一份状态、不双写。
  selected?: CommandManifest
  values: Record<string, unknown>
  backgroundTabs: CommandTab[]
  activeTabSlot: number
  selectCommand: (cmd: CommandManifest) => void
  closeTab: (commandKey: string) => void
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
  // 模块切换。**不持久化**:这是浏览姿势(此刻在看哪个模块),不是用户偏好,重开回默认更合理。
  activeModule: 'commands' | 'login' | 'vk' | 'providers' | 'radar'
  setActiveModule: (m: 'commands' | 'login' | 'vk' | 'providers' | 'radar') => void
  // 导航折叠状态。**必须放在 store 里,不能留在 SiteCommandNav 的 useState**:顶栏切到
  // 「登录状态/视频解析」时 AppShell 改渲染整页模块,三栏连同导航一起从树上摘掉
  // (AppShell.tsx 的 fullPage 分支),组件局部 state 随卸载归零——用户刚收起的分组
  // 切回来又全开着。与 activeModule 同理**不落 localStorage**:这是浏览姿势不是偏好,
  // 重开应用回到干净状态;要的只是"同一次会话内跨模块切换不丢"。
  navExpandedSites: Set<string>
  toggleNavSite: (site: string) => void
  navSectionOpen: Record<NavSectionKey, boolean>
  toggleNavSection: (key: NavSectionKey) => void
  // —— vk 切片(视频解析)——跨模块交接:「送去视频解析」只传规范化 URL 与脱敏
  // provenance(commandKey/collectedAt),严禁携带行数据或第二种 manifest 格式。
  vkHandoff?: { url: string; commandKey: string; collectedAt: number }
  setVkHandoff: (handoff: { url: string; commandKey: string; collectedAt: number }) => void
  clearVkHandoff: () => void
  // 登录状态校验。队列是**串行**的:Host 侧 maxConcurrentRuns=1,并发发起只会让后来的拿 429。
  // 驱动逻辑不在 store 里(store 不碰 host),由 App 的 effect 取队首去发起。
  loginChecks: Record<string, LoginCheckEntry>
  loginQueue: string[]
  // 复数:65 个站点全是浏览器命令,串行跑完要几分钟,而单次进程启动只占 45ms ——
  // 时间全在浏览器往返上,唯一的提速手段就是同时跑几个。改成数组而不是留个
  // 单数字段加计数,是为了让每个消费点都被迫显式处理"多个在飞"这件事。
  loginInFlights: { site: string; runId: string }[]
  setLoginEntry: (site: string, patch: Partial<LoginCheckEntry>) => void
  enqueueLoginChecks: (sites: string[]) => void
  beginLoginCheck: (site: string, runId: string) => void
  finishLoginCheck: (runId: string, state: LoginCheckState, detail: string | undefined, at: number) => void
  // —— preferences 切片 ——
  preferences: PreferencesSnapshot
  stale: { sites: Set<string>; commands: Set<string> }
  hydratePreferences: () => void
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
  setCommands: (commands, decisions) => set((s) => {
    // 后台标签同规则校正;key 已从目录消失的标签直接移除,activeTabSlot 随之左移
    const background: CommandTab[] = []
    let slot = s.activeTabSlot
    s.backgroundTabs.forEach((tab, i) => {
      const next = reconcileSelection(tab.command, tab.values, commands)
      if (next.selected) background.push({ ...tab, command: next.selected, values: next.values })
      else if (i < s.activeTabSlot) slot -= 1
    })
    const current = reconcileSelection(s.selected, s.values, commands)
    const shared = {
      commands, catalogStatus: 'ready' as const, catalogError: undefined,
      decisions: new Map((decisions ?? []).map((d) => [d.commandKey, d])),
      stale: staleKeys(s.preferences, commands),
    }
    // 当前标签被删而还有别的标签:让邻居顶上来。没有别的标签则只清 selected/values,currentRun 不动。
    if (s.selected && !current.selected && background.length > 0) {
      return { ...shared, ...activateNeighbor(background, slot) }
    }
    return { ...shared, ...current, backgroundTabs: background, activeTabSlot: slot }
  }),
  decisions: new Map(),
  decisionFor: (commandKey) => get().decisions.get(commandKey),
  catalogStatus: 'loading',
  catalogError: undefined,
  setCatalogStatus: (status, error) => set({ catalogStatus: status, catalogError: error }),
  selected: undefined,
  values: {},
  backgroundTabs: [],
  activeTabSlot: 0,
  selectCommand: (cmd) => set((s) => {
    if (s.selected?.command === cmd.command) return s
    const tabs = commandTabs(s)
    const index = tabs.findIndex((tab) => tab.command.command === cmd.command)
    // 已有标签:切过去,标签栏顺序不变(当前标签留在原位变成后台标签)
    if (index >= 0) return activateTab(tabs, index)
    return { selected: cmd, values: defaultsOf(cmd), currentRun: undefined, backgroundTabs: tabs, activeTabSlot: tabs.length }
  }),
  closeTab: (commandKey) => set((s) => {
    if (s.selected?.command === commandKey) return activateNeighbor(s.backgroundTabs, s.activeTabSlot)
    const index = s.backgroundTabs.findIndex((tab) => tab.command.command === commandKey)
    if (index < 0) return s
    return {
      backgroundTabs: s.backgroundTabs.filter((_, i) => i !== index),
      activeTabSlot: index < s.activeTabSlot ? s.activeTabSlot - 1 : s.activeTabSlot,
    }
  }),
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
  appendOutput: (e) => set((s) => patchRun(s, e.runId, (run) => applyOutput(run, e)) ?? s),
  finishRun: (e) => set((s) => patchRun(s, e.runId, (run) => applyDone(run, e)) ?? s),
  markCancelling: () => set((s) => {
    if (!s.currentRun) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'CANCEL' }) } }
  }),
  runPanelCollapsed: false,
  setRunPanelCollapsed: (v) => set({ runPanelCollapsed: v }),
  mode: 'demo',
  setMode: (mode) => set({ mode }),
  activeModule: 'commands',
  setActiveModule: (m) => set({ activeModule: m }),
  // 站点默认全收起(175 站点平铺是一条翻不到底的长带);三个固定分组默认展开(短列表,
  // 折叠只会多一次点击)。这两个默认值原本在组件里,连同状态一起搬过来,语义不变。
  navExpandedSites: new Set<string>(),
  toggleNavSite: (site) => set((s) => {
    const next = new Set(s.navExpandedSites)
    if (next.has(site)) next.delete(site)
    else next.add(site)
    return { navExpandedSites: next }
  }),
  navSectionOpen: { recent: true, favSites: true, favCommands: true, allSites: true },
  toggleNavSection: (key) => set((s) => ({
    navSectionOpen: { ...s.navSectionOpen, [key]: !s.navSectionOpen[key] },
  })),
  // —— vk 切片 ——
  vkHandoff: undefined,
  setVkHandoff: (handoff) => set({ vkHandoff: handoff, activeModule: 'vk' }),
  clearVkHandoff: () => set({ vkHandoff: undefined }),
  loginChecks: {},
  loginQueue: [],
  loginInFlights: [],
  setLoginEntry: (site, patch) => set((s) => ({
    loginChecks: { ...s.loginChecks, [site]: { ...s.loginChecks[site], site, ...patch } as LoginCheckEntry },
  })),
  enqueueLoginChecks: (sites) => set((s) => {
    // 去重:已排队或正在跑的站点不重复入列,否则连点「全部刷新」会把队列堆成几十条。
    const busy = new Set([...s.loginQueue, ...s.loginInFlights.map((x) => x.site)])
    const add = sites.filter((x) => !busy.has(x))
    if (add.length === 0) return s
    const checks = { ...s.loginChecks }
    for (const site of add) checks[site] = { ...checks[site], site, state: 'queued' }
    return { loginQueue: [...s.loginQueue, ...add], loginChecks: checks }
  }),
  beginLoginCheck: (site, runId) => set((s) => ({
    loginQueue: s.loginQueue.filter((x) => x !== site),
    loginInFlights: [...s.loginInFlights, { site, runId }],
    loginChecks: { ...s.loginChecks, [site]: { ...s.loginChecks[site], site, state: 'checking' } },
  })),
  finishLoginCheck: (runId, state, detail, at) => set((s) => {
    // 只认还在飞的那次:迟到的 done(上一轮超时后才回来的)不得覆盖新结果。
    // 并发之后这条更要紧 —— 多个 runId 同时在飞,按 runId 定位才不会张冠李戴。
    const hit = s.loginInFlights.find((x) => x.runId === runId)
    if (!hit) return s
    return {
      loginInFlights: s.loginInFlights.filter((x) => x.runId !== runId),
      loginChecks: { ...s.loginChecks, [hit.site]: { ...s.loginChecks[hit.site], site: hit.site, state, detail, checkedAt: at } },
    }
  }),
  // —— preferences 切片 ——
  preferences: emptyPreferences(),
  stale: { sites: new Set<string>(), commands: new Set<string>() },
  hydratePreferences: () => set((s) => {
    const preferences = loadPreferences()
    return { preferences, stale: staleKeys(preferences, s.commands) }
  }),
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
