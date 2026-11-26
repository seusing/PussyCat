import { create } from 'zustand'
import type { DoneEvent, HostBridge, OutputEvent } from '../../host/types'
import {
  DOT_CHAT_COMMAND, DOT_STOP_COMMAND, dotChatRunId, dotStopRunId, isDotStopRunId, parseDotLine,
} from './dotProtocol'
import {
  conversationTitle, readDotHistory, serializeDotHistory,
  type DotConversation, type DotHistoryPersistence, type DotTurn,
} from './dotHistory'

export type { DotConversation, DotTurn, DotTurnState } from './dotHistory'

/** 对话记录的存取状态:没接宿主(演示模式、测试)时只在内存里。 */
export type DotHistoryPhase = 'memory' | 'loading' | 'ready' | 'error'

type DotChatState = {
  /** 全部对话,存档顺序;列表按 updatedAt 排 */
  conversations: DotConversation[]
  /** 正在看的对话;null 是还没问第一句的新对话 */
  activeId: string | null
  activeRunId: string | null
  host: HostBridge | null
  history: { phase: DotHistoryPhase; error: string }
  bindHost: (host: HostBridge) => void
  ask: (question: string) => void
  stop: () => void
  regenerate: () => void
  newConversation: () => void
  openConversation: (id: string) => void
  retryHistory: () => void
  handleOutput: (event: OutputEvent) => void
  handleDone: (event: DoneEvent) => void
}

// 停止后等 chat 自己收尾的时间;到点还没结束就直接取消进程
const STOP_GRACE_MS = 5000
// 与适配器的上限一致(xiaohongshu-dot/chat.js 的 MAX_TIMEOUT_SECONDS)
const ANSWER_TIMEOUT_SECONDS = 180
// 点点只有一个浏览器标签:视频解析的点点速览正在用时,这一问自动排队,隔一会儿再试,最多等两分钟
const BUSY_RETRY_MS = 2000
const BUSY_RETRY_LIMIT = 60
export const QUEUED_STEP = '点点正忙，排队中'
// 存档:改动停下来 800ms 后整份写一次;一直在变(回答流式到达)时最多攒 4 秒
const SAVE_DEBOUNCE_MS = 800
const SAVE_MAX_WAIT_MS = 4000
const SAVE_RETRY_MS = 10_000

let stopTimer: ReturnType<typeof setTimeout> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined

const isSessionBusy = (event: DoneEvent) => [event.error?.summary, event.error?.detail].some((text) => /SESSION_BUSY/.test(text ?? ''))
const isLive = (turn: DotTurn) => turn.state === 'waiting' || turn.state === 'streaming'

function errorSummary(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'summary' in error && typeof error.summary === 'string') return error.summary
  return error instanceof Error && error.message ? error.message : fallback
}

const nonce = () => crypto.randomUUID()

export const selectActiveConversation = (state: Pick<DotChatState, 'conversations' | 'activeId'>) =>
  state.conversations.find((conversation) => conversation.id === state.activeId) ?? null

/** 正在回答的那个对话的 id;没有在答的返回 null。 */
export const selectLiveConversationId = (state: Pick<DotChatState, 'conversations' | 'activeRunId'>) =>
  (state.activeRunId
    ? state.conversations.find((conversation) => conversation.turns.some((turn) => turn.runId === state.activeRunId))?.id ?? null
    : null)

const EMPTY_TURNS: DotTurn[] = []

export const useDotChat = create<DotChatState>((set, get) => {
  const patchTurn = (runId: string, patch: (turn: DotTurn) => Partial<DotTurn>) => set((state) => ({
    conversations: state.conversations.map((conversation) => (conversation.turns.some((turn) => turn.runId === runId)
      ? { ...conversation, turns: conversation.turns.map((turn) => (turn.runId === runId ? { ...turn, ...patch(turn) } : turn)) }
      : conversation)),
  }))
  const patchConversationOf = (runId: string, patch: Partial<DotConversation>) => set((state) => ({
    conversations: state.conversations.map((conversation) => (conversation.turns.some((turn) => turn.runId === runId)
      ? { ...conversation, ...patch }
      : conversation)),
  }))
  const finish = (turn: DotTurn): Pick<DotTurn, 'finishedAt'> => ({ finishedAt: turn.finishedAt ?? Date.now() })
  const cancelActive = () => {
    const { host, activeRunId } = get()
    if (host && activeRunId) void host.cancelCommand(activeRunId).catch(() => {})
  }
  // 起一条 chat 运行回答这一问(第一次提问和排队重试都走这里)
  const startRun = (conversationId: string, turnId: string) => {
    const { host, conversations } = get()
    const conversation = conversations.find((item) => item.id === conversationId)
    const turn = conversation?.turns.find((item) => item.id === turnId)
    if (!host || !conversation || !turn) return
    const runId = dotChatRunId(nonce())
    set((state) => ({
      activeRunId: runId,
      conversations: state.conversations.map((item) => (item.id === conversationId
        ? { ...item, turns: item.turns.map((entry) => (entry.id === turnId ? { ...entry, runId } : entry)) }
        : item)),
    }))
    const argv = ['xiaohongshu-dot', 'chat', turn.question]
    if (conversation.remoteId) argv.push('--conversation', conversation.remoteId)
    argv.push('--timeout', String(ANSWER_TIMEOUT_SECONDS), '-f', 'json')
    host.startCommand({ runId, commandKey: DOT_CHAT_COMMAND, argv }).catch((error: unknown) => {
      patchTurn(runId, (item) => ({ state: 'error', error: errorSummary(error, '点点没能开始回答'), ...finish(item) }))
      if (get().activeRunId === runId) set({ activeRunId: null })
    })
  }

  return {
    conversations: [],
    activeId: null,
    activeRunId: null,
    host: null,
    history: { phase: 'memory', error: '' },
    bindHost: (host) => set({ host }),

    ask: (question) => {
      const text = question.trim()
      const { host, activeRunId, activeId, conversations } = get()
      if (!text || !host || activeRunId) return
      const now = Date.now()
      const turn: DotTurn = {
        id: nonce(), question: text, answer: '', steps: [], references: [], sourceTotal: '', followUps: [],
        state: 'waiting', startedAt: now, runId: '', busyRetries: 0,
      }
      const current = conversations.find((item) => item.id === activeId)
      const conversationId = current?.id ?? nonce()
      set((state) => ({
        activeId: conversationId,
        conversations: current
          ? state.conversations.map((item) => (item.id === conversationId ? { ...item, updatedAt: now, turns: [...item.turns, turn] } : item))
          : [...state.conversations, {
            id: conversationId, remoteId: null, title: conversationTitle(text), createdAt: now, updatedAt: now, turns: [turn],
          }],
      }))
      startRun(conversationId, turn.id)
    },

    // 停止:界面立刻定格;再让点点自己停下,chat 看到记号后正常收尾。点点那边停不了就直接取消进程。
    stop: () => {
      const { host, activeRunId } = get()
      if (!host || !activeRunId) return
      patchTurn(activeRunId, (turn) => (isLive(turn) ? { state: 'stopped', ...finish(turn) } : {}))
      // 还在排队(没有在跑的运行):不用叫点点停,直接结束
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer)
        retryTimer = undefined
        set({ activeRunId: null })
        return
      }
      const stopRunId = dotStopRunId(nonce())
      host.startCommand({ runId: stopRunId, commandKey: DOT_STOP_COMMAND, argv: ['xiaohongshu-dot', 'stop', '-f', 'json'] })
        .catch(() => cancelActive())
      clearTimeout(stopTimer)
      stopTimer = setTimeout(() => {
        if (get().activeRunId === activeRunId) cancelActive()
      }, STOP_GRACE_MS)
    },

    regenerate: () => {
      const { activeRunId } = get()
      const conversation = selectActiveConversation(get())
      const last = conversation?.turns[conversation.turns.length - 1]
      if (!conversation || !last || activeRunId) return
      set((state) => ({
        conversations: state.conversations.map((item) => (item.id === conversation.id ? { ...item, turns: item.turns.slice(0, -1) } : item)),
      }))
      get().ask(last.question)
    },

    newConversation: () => set({ activeId: null }),

    openConversation: (id) => {
      if (get().conversations.some((conversation) => conversation.id === id)) set({ activeId: id })
    },

    retryHistory: () => {
      if (get().history.phase === 'error') void loadHistory()
    },

    handleOutput: (event) => {
      if (event.runId !== get().activeRunId || event.stream !== 'stderr') return
      const parsed = parseDotLine(event.text)
      if (!parsed) return
      switch (parsed.type) {
        case 'start':
          if (parsed.conversationId) patchConversationOf(event.runId, { remoteId: parsed.conversationId })
          return
        case 'status':
          patchTurn(event.runId, (turn) => (turn.steps.includes(parsed.text) ? {} : { steps: [...turn.steps, parsed.text] }))
          return
        case 'delta':
          patchTurn(event.runId, (turn) => (isLive(turn)
            ? { answer: turn.answer + parsed.text, state: 'streaming', answeredAt: turn.answeredAt ?? Date.now() }
            : {}))
          return
        case 'replace':
          patchTurn(event.runId, (turn) => (isLive(turn)
            ? { answer: parsed.text, state: 'streaming', answeredAt: turn.answeredAt ?? Date.now() }
            : {}))
          return
        case 'references':
          patchTurn(event.runId, () => ({ references: parsed.items }))
          return
        case 'done':
          patchTurn(event.runId, (turn) => ({
            sourceTotal: parsed.sourceTotal,
            followUps: parsed.followUps,
            ...(isLive(turn) ? { state: parsed.interrupted ? 'stopped' : 'done', ...finish(turn) } : {}),
          }))
          return
        case 'error':
          patchTurn(event.runId, (turn) => (turn.state === 'stopped' ? {} : { state: 'error', error: parsed.message, ...finish(turn) }))
          return
      }
    },

    handleDone: (event) => {
      if (isDotStopRunId(event.runId)) {
        // 点点那边没停成(页面不在、或命令没跑起来):直接取消正在跑的 chat
        const stopped = event.outcome === 'success' && event.result?.[0]?.stopped === true
        if (!stopped) cancelActive()
        return
      }
      if (event.runId !== get().activeRunId) return
      clearTimeout(stopTimer)
      const conversation = get().conversations.find((item) => item.turns.some((turn) => turn.runId === event.runId))
      const turn = conversation?.turns.find((item) => item.runId === event.runId)
      if (conversation && turn && isLive(turn) && event.outcome === 'error' && isSessionBusy(event) && turn.busyRetries < BUSY_RETRY_LIMIT) {
        // 点点正被别处占用:这一问保持「在答」,排队后重试
        patchTurn(event.runId, (item) => ({
          busyRetries: item.busyRetries + 1,
          steps: item.steps.includes(QUEUED_STEP) ? item.steps : [...item.steps, QUEUED_STEP],
        }))
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          startRun(conversation.id, turn.id)
        }, BUSY_RETRY_MS)
        return
      }
      set({ activeRunId: null })
      patchTurn(event.runId, (item) => {
        if (!isLive(item)) return {}
        if (event.outcome === 'success') return { state: 'done', ...finish(item) }
        if (event.outcome === 'cancelled') return { state: 'stopped', ...finish(item) }
        return { state: 'error', error: event.error?.summary ?? '点点这次没有答出来', ...finish(item) }
      })
    },
  }
})

/** 正在看的对话的各轮;新对话是空数组(同一个引用,不触发重渲染)。 */
export function useActiveTurns(): DotTurn[] {
  return useDotChat((state) => selectActiveConversation(state)?.turns ?? EMPTY_TURNS)
}

// —— 存档 ——
// 权威存储是宿主上的文件。这里持有内存副本(就是 store 里的 conversations),有改动就去抖整份写回。
// 读回完成前不写:免得用一份不全的记录盖掉文件;读失败也不写,等用户重试。

let persistence: DotHistoryPersistence | null = null
let epoch = 0
let saveTimer: ReturnType<typeof setTimeout> | undefined
let firstDirtyAt = 0
let saving = false
let dirty = false
let unsubscribe: (() => void) | null = null
let pagehideBound = false

const setHistory = (phase: DotHistoryPhase, error = '') => useDotChat.setState({ history: { phase, error } })

function schedulePersist(delay = SAVE_DEBOUNCE_MS) {
  if (!persistence || useDotChat.getState().history.phase !== 'ready') return
  const now = Date.now()
  if (!dirty) {
    dirty = true
    firstDirtyAt = now
  }
  clearTimeout(saveTimer)
  const due = Math.min(now + delay, firstDirtyAt + SAVE_MAX_WAIT_MS)
  saveTimer = setTimeout(() => { void flushPersist() }, Math.max(0, due - now))
}

async function flushPersist() {
  clearTimeout(saveTimer)
  saveTimer = undefined
  if (!persistence || saving || !dirty || useDotChat.getState().history.phase !== 'ready') return
  const target = persistence
  const current = epoch
  saving = true
  dirty = false
  let failed = false
  try {
    await target.save(serializeDotHistory(useDotChat.getState().conversations))
  } catch {
    failed = true
  }
  if (current !== epoch) return
  saving = false
  // 写的过程中又有新改动,或写失败了:排下一次(失败的隔一会儿再试,期间有新改动会提前)
  if (failed) dirty = true
  if (!dirty || saveTimer !== undefined) return
  if (failed) {
    firstDirtyAt = Date.now()
    saveTimer = setTimeout(() => { void flushPersist() }, SAVE_RETRY_MS)
  } else {
    schedulePersist(0)
  }
}

async function loadHistory() {
  const source = persistence
  if (!source) return
  const current = epoch
  setHistory('loading')
  try {
    const remote = await source.load()
    if (current !== epoch) return
    const stored = remote.exists ? readDotHistory(remote.history) : []
    // 读回期间新问的对话(存档里没有)排在后面一起留下
    const storedIds = new Set(stored.map((conversation) => conversation.id))
    const fresh = useDotChat.getState().conversations.filter((conversation) => !storedIds.has(conversation.id))
    useDotChat.setState({ conversations: [...stored, ...fresh] })
    setHistory('ready')
    if (fresh.length > 0) schedulePersist(0)
  } catch (error) {
    if (current !== epoch) return
    setHistory('error', `读取点点对话记录失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 应用启动时调用:接上宿主并读回对话记录。 */
export function connectDotHistory(next: DotHistoryPersistence): void {
  persistence = next
  if (!unsubscribe) {
    unsubscribe = useDotChat.subscribe((state, previous) => {
      if (state.conversations !== previous.conversations) schedulePersist()
    })
  }
  if (!pagehideBound && typeof window !== 'undefined') {
    pagehideBound = true
    window.addEventListener('pagehide', () => { void flushPersist() })
  }
  void loadHistory()
}

export function resetDotHistoryForTests(): void {
  epoch += 1
  clearTimeout(saveTimer)
  saveTimer = undefined
  saving = false
  dirty = false
  persistence = null
  unsubscribe?.()
  unsubscribe = null
  useDotChat.setState({ history: { phase: 'memory', error: '' } })
}
