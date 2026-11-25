import { create } from 'zustand'
import type { DoneEvent, HostBridge, OutputEvent } from '../../host/types'
import {
  DOT_CHAT_COMMAND, DOT_STOP_COMMAND, dotChatRunId, dotStopRunId, isDotStopRunId, parseDotLine,
  type DotReference,
} from './dotProtocol'

export type DotTurnState = 'waiting' | 'streaming' | 'done' | 'stopped' | 'error'

export type DotTurn = {
  id: string
  question: string
  answer: string
  /** 点点的过程步骤(搜索、整理……),按出现顺序 */
  steps: string[]
  references: DotReference[]
  /** 点点给的出处说明,例如「ai总结 12 篇笔记生成」 */
  sourceTotal: string
  state: DotTurnState
  error?: string
  runId: string
  /** 点点被占用(视频解析的点点速览正在问)时已经排队重试了几次 */
  busyRetries: number
}

type DotChatState = {
  turns: DotTurn[]
  /** 点点那边的会话 id;下一问带上它接着聊,新对话时清空 */
  conversationId: string | null
  activeRunId: string | null
  host: HostBridge | null
  bindHost: (host: HostBridge) => void
  ask: (question: string) => void
  stop: () => void
  regenerate: () => void
  newConversation: () => void
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

let stopTimer: ReturnType<typeof setTimeout> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined

const isSessionBusy = (event: DoneEvent) => [event.error?.summary, event.error?.detail].some((text) => /SESSION_BUSY/.test(text ?? ''))

function errorSummary(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'summary' in error && typeof error.summary === 'string') return error.summary
  return error instanceof Error && error.message ? error.message : fallback
}

const nonce = () => crypto.randomUUID()

export const useDotChat = create<DotChatState>((set, get) => {
  const patchTurn = (runId: string, patch: (turn: DotTurn) => Partial<DotTurn>) => set((state) => ({
    turns: state.turns.map((turn) => (turn.runId === runId ? { ...turn, ...patch(turn) } : turn)),
  }))
  const isLive = (turn: DotTurn) => turn.state === 'waiting' || turn.state === 'streaming'
  const cancelActive = () => {
    const { host, activeRunId } = get()
    if (host && activeRunId) void host.cancelCommand(activeRunId).catch(() => {})
  }
  // 起一条 chat 运行回答这一问(第一次提问和排队重试都走这里)
  const startRun = (turnId: string) => {
    const { host, conversationId, turns } = get()
    const turn = turns.find((item) => item.id === turnId)
    if (!host || !turn) return
    const runId = dotChatRunId(nonce())
    set((state) => ({
      activeRunId: runId,
      turns: state.turns.map((item) => (item.id === turnId ? { ...item, runId } : item)),
    }))
    const argv = ['xiaohongshu-dot', 'chat', turn.question]
    if (conversationId) argv.push('--conversation', conversationId)
    argv.push('--timeout', String(ANSWER_TIMEOUT_SECONDS), '-f', 'json')
    host.startCommand({ runId, commandKey: DOT_CHAT_COMMAND, argv }).catch((error: unknown) => {
      patchTurn(runId, () => ({ state: 'error', error: errorSummary(error, '点点没能开始回答') }))
      if (get().activeRunId === runId) set({ activeRunId: null })
    })
  }

  return {
    turns: [],
    conversationId: null,
    activeRunId: null,
    host: null,
    bindHost: (host) => set({ host }),

    ask: (question) => {
      const text = question.trim()
      const { host, activeRunId } = get()
      if (!text || !host || activeRunId) return
      const turn: DotTurn = {
        id: nonce(), question: text, answer: '', steps: [], references: [], sourceTotal: '',
        state: 'waiting', runId: '', busyRetries: 0,
      }
      set((state) => ({ turns: [...state.turns, turn] }))
      startRun(turn.id)
    },

    // 停止:界面立刻定格;再让点点自己停下,chat 看到记号后正常收尾。点点那边停不了就直接取消进程。
    stop: () => {
      const { host, activeRunId } = get()
      if (!host || !activeRunId) return
      patchTurn(activeRunId, (turn) => (isLive(turn) ? { state: 'stopped' } : {}))
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
      const { turns, activeRunId } = get()
      const last = turns[turns.length - 1]
      if (!last || activeRunId) return
      set({ turns: turns.slice(0, -1) })
      get().ask(last.question)
    },

    newConversation: () => {
      if (get().activeRunId) return
      set({ turns: [], conversationId: null })
    },

    handleOutput: (event) => {
      if (event.runId !== get().activeRunId || event.stream !== 'stderr') return
      const parsed = parseDotLine(event.text)
      if (!parsed) return
      switch (parsed.type) {
        case 'start':
          set({ conversationId: parsed.conversationId || null })
          return
        case 'status':
          patchTurn(event.runId, (turn) => (turn.steps.includes(parsed.text) ? {} : { steps: [...turn.steps, parsed.text] }))
          return
        case 'delta':
          patchTurn(event.runId, (turn) => (isLive(turn) ? { answer: turn.answer + parsed.text, state: 'streaming' } : {}))
          return
        case 'replace':
          patchTurn(event.runId, (turn) => (isLive(turn) ? { answer: parsed.text, state: 'streaming' } : {}))
          return
        case 'references':
          patchTurn(event.runId, () => ({ references: parsed.items }))
          return
        case 'done':
          patchTurn(event.runId, (turn) => ({
            sourceTotal: parsed.sourceTotal,
            ...(isLive(turn) ? { state: parsed.interrupted ? 'stopped' : 'done' } : {}),
          }))
          return
        case 'error':
          patchTurn(event.runId, (turn) => (turn.state === 'stopped' ? {} : { state: 'error', error: parsed.message }))
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
      const turn = get().turns.find((item) => item.runId === event.runId)
      if (turn && isLive(turn) && event.outcome === 'error' && isSessionBusy(event) && turn.busyRetries < BUSY_RETRY_LIMIT) {
        // 点点正被别处占用:这一问保持「在答」,排队后重试
        patchTurn(event.runId, (item) => ({
          busyRetries: item.busyRetries + 1,
          steps: item.steps.includes(QUEUED_STEP) ? item.steps : [...item.steps, QUEUED_STEP],
        }))
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          startRun(turn.id)
        }, BUSY_RETRY_MS)
        return
      }
      set({ activeRunId: null })
      patchTurn(event.runId, (turn) => {
        if (!isLive(turn)) return {}
        if (event.outcome === 'success') return { state: 'done' }
        if (event.outcome === 'cancelled') return { state: 'stopped' }
        return { state: 'error', error: event.error?.summary ?? '点点这次没有答出来' }
      })
    },
  }
})
