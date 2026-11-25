import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DoneEvent, HostBridge, OutputEvent, RunRequest } from '../../host/types'
import { useDotChat } from './dotChatStore'

const line = (event: Record<string, unknown>) => `@@zz-dot ${JSON.stringify(event)}`

function fakeHost() {
  const started: RunRequest[] = []
  const cancelled: string[] = []
  const host: HostBridge = {
    startCommand: vi.fn(async (req: RunRequest) => { started.push(req); return { runId: req.runId } }),
    cancelCommand: vi.fn(async (runId: string) => { cancelled.push(runId) }),
    onOutput: () => () => {},
    onDone: () => () => {},
  }
  return { host, started, cancelled }
}

let seq = 0
const out = (runId: string, text: string, stream: 'stdout' | 'stderr' = 'stderr'): OutputEvent => ({ runId, seq: seq++, at: 0, stream, text })
const done = (runId: string, outcome: DoneEvent['outcome'], extra: Partial<DoneEvent> = {}): DoneEvent => ({ runId, at: 0, outcome, ...extra })
const state = () => useDotChat.getState()
const lastTurn = () => state().turns[state().turns.length - 1]

beforeEach(() => {
  useDotChat.setState({ turns: [], conversationId: null, activeRunId: null, host: null })
})
afterEach(() => vi.useRealTimers())

describe('useDotChat', () => {
  it('提问:起一条 chat 运行,流式拼出回答,带上会话 id 接着问', () => {
    const { host, started } = fakeHost()
    state().bindHost(host)
    state().ask('  我有几个收藏夹？ ')
    expect(started[0]).toMatchObject({
      commandKey: 'xiaohongshu-dot/chat',
      argv: ['xiaohongshu-dot', 'chat', '我有几个收藏夹？', '--timeout', '180', '-f', 'json'],
    })
    const runId = started[0].runId
    expect(lastTurn()).toMatchObject({ question: '我有几个收藏夹？', state: 'waiting' })

    state().handleOutput(out(runId, line({ type: 'start', conversationId: 'c1', messageId: 'm1' })))
    state().handleOutput(out(runId, line({ type: 'status', text: '正在查看你的收藏' })))
    state().handleOutput(out(runId, line({ type: 'status', text: '正在查看你的收藏' })))
    state().handleOutput(out(runId, line({ type: 'delta', text: '你有 ' })))
    state().handleOutput(out(runId, line({ type: 'delta', text: '3 个收藏夹' })))
    state().handleOutput(out(runId, 'opencli 的普通日志'))
    state().handleOutput(out(runId, line({ type: 'delta', text: '不该出现' }), 'stdout'))
    expect(lastTurn()).toMatchObject({ answer: '你有 3 个收藏夹', state: 'streaming', steps: ['正在查看你的收藏'] })

    state().handleOutput(out(runId, line({ type: 'done', sourceTotal: 'ai为你回答', interrupted: false })))
    state().handleDone(done(runId, 'success'))
    expect(lastTurn()).toMatchObject({ state: 'done', sourceTotal: 'ai为你回答' })
    expect(state().activeRunId).toBeNull()

    state().ask('再看看')
    expect(started[1].argv).toEqual(['xiaohongshu-dot', 'chat', '再看看', '--conversation', 'c1', '--timeout', '180', '-f', 'json'])
  })

  it('回答没结束时不能再问', () => {
    const { host, started } = fakeHost()
    state().bindHost(host)
    state().ask('一')
    state().ask('二')
    expect(started).toHaveLength(1)
  })

  it('停止:界面立刻定格,后到的增量不再追加;点点停成了就等 chat 自己收尾', () => {
    const { host, started, cancelled } = fakeHost()
    state().bindHost(host)
    state().ask('长问题')
    const chatRunId = started[0].runId
    state().handleOutput(out(chatRunId, line({ type: 'delta', text: '第一段' })))
    state().stop()
    expect(lastTurn().state).toBe('stopped')
    expect(started[1]).toMatchObject({ commandKey: 'xiaohongshu-dot/stop', argv: ['xiaohongshu-dot', 'stop', '-f', 'json'] })

    state().handleOutput(out(chatRunId, line({ type: 'delta', text: '第二段' })))
    state().handleDone(done(started[1].runId, 'success', { result: [{ stopped: true }] }))
    state().handleOutput(out(chatRunId, line({ type: 'done', sourceTotal: '', interrupted: true })))
    state().handleDone(done(chatRunId, 'success'))
    expect(lastTurn()).toMatchObject({ state: 'stopped', answer: '第一段' })
    expect(cancelled).toEqual([])
    expect(state().activeRunId).toBeNull()
  })

  it('点点那边没停成:直接取消 chat 运行', () => {
    const { host, started, cancelled } = fakeHost()
    state().bindHost(host)
    state().ask('问')
    state().stop()
    state().handleDone(done(started[1].runId, 'success', { result: [{ stopped: false }] }))
    expect(cancelled).toEqual([started[0].runId])
  })

  it('停止后 chat 迟迟不收尾:宽限期到了就取消', () => {
    vi.useFakeTimers()
    const { host, started, cancelled } = fakeHost()
    state().bindHost(host)
    state().ask('问')
    state().stop()
    vi.advanceTimersByTime(5000)
    expect(cancelled).toEqual([started[0].runId])
  })

  it('出错:显示事件里的原因;运行失败但没有事件时用宿主给的摘要', () => {
    const { host, started } = fakeHost()
    state().bindHost(host)
    state().ask('问')
    state().handleOutput(out(started[0].runId, line({ type: 'error', message: '点点页面被刷新，这条回答中断了' })))
    state().handleDone(done(started[0].runId, 'error', { error: { summary: '命令执行失败' } }))
    expect(lastTurn()).toMatchObject({ state: 'error', error: '点点页面被刷新，这条回答中断了' })

    state().ask('再问')
    state().handleDone(done(started[1].runId, 'error', { error: { summary: '需要先登录 www.xiaohongshu.com：在 Chrome 里登录后重试' } }))
    expect(lastTurn()).toMatchObject({ state: 'error', error: '需要先登录 www.xiaohongshu.com：在 Chrome 里登录后重试' })
  })

  it('宿主拒绝启动:这一问直接标为出错,可以继续问', async () => {
    const { host } = fakeHost()
    host.startCommand = vi.fn(async () => { throw Object.assign(new Error('x'), { summary: '宿主未连接' }) })
    state().bindHost(host)
    state().ask('问')
    await vi.waitFor(() => expect(lastTurn().state).toBe('error'))
    expect(lastTurn().error).toBe('宿主未连接')
    expect(state().activeRunId).toBeNull()
  })

  it('重新生成:去掉最后一问,原样再问一次;新对话清空会话', () => {
    const { host, started } = fakeHost()
    state().bindHost(host)
    state().ask('问题')
    state().handleOutput(out(started[0].runId, line({ type: 'start', conversationId: 'c1', messageId: 'm1' })))
    state().handleDone(done(started[0].runId, 'success'))
    state().regenerate()
    expect(state().turns).toHaveLength(1)
    expect(started[1].argv.slice(0, 5)).toEqual(['xiaohongshu-dot', 'chat', '问题', '--conversation', 'c1'])
    state().handleDone(done(started[1].runId, 'success'))
    state().newConversation()
    expect(state()).toMatchObject({ turns: [], conversationId: null })
  })

  it('点点正被视频解析占用:这一问自动排队,隔一会儿用同一个问题、同一个会话再试', () => {
    vi.useFakeTimers()
    const { host, started } = fakeHost()
    state().bindHost(host)
    useDotChat.setState({ conversationId: 'c1' })
    state().ask('问题')
    const busy = { summary: '该网站上一条写入命令还没结束：等它结束或取消约 45 秒后再试', detail: 'OpenCLI exited with code 75\nSESSION_BUSY: Session "site:xiaohongshu-dot" is busy' }
    state().handleDone(done(started[0].runId, 'error', { error: busy }))
    expect(lastTurn()).toMatchObject({ state: 'waiting', steps: ['点点正忙，排队中'], busyRetries: 1 })
    expect(state().activeRunId).toBe(started[0].runId)
    expect(started).toHaveLength(1)

    vi.advanceTimersByTime(2000)
    expect(started).toHaveLength(2)
    expect(started[1].argv).toEqual(['xiaohongshu-dot', 'chat', '问题', '--conversation', 'c1', '--timeout', '180', '-f', 'json'])
    expect(lastTurn().runId).toBe(started[1].runId)
    state().handleOutput(out(started[1].runId, line({ type: 'delta', text: '轮到了' })))
    state().handleDone(done(started[1].runId, 'success'))
    expect(lastTurn()).toMatchObject({ state: 'done', answer: '轮到了' })
  })

  it('排队时点停止:直接结束,不再重试', () => {
    vi.useFakeTimers()
    const { host, started } = fakeHost()
    state().bindHost(host)
    state().ask('问题')
    state().handleDone(done(started[0].runId, 'error', { error: { summary: 'x', detail: 'SESSION_BUSY: busy' } }))
    state().stop()
    vi.advanceTimersByTime(10_000)
    expect(started).toHaveLength(1)
    expect(lastTurn().state).toBe('stopped')
    expect(state().activeRunId).toBeNull()
  })

  it('排队两分钟还轮不到:报出错', () => {
    vi.useFakeTimers()
    const { host, started } = fakeHost()
    state().bindHost(host)
    state().ask('问题')
    const busy = { summary: '该网站上一条写入命令还没结束', detail: 'SESSION_BUSY: busy' }
    for (let attempt = 0; attempt <= 60; attempt += 1) {
      state().handleDone(done(started[started.length - 1].runId, 'error', { error: busy }))
      vi.advanceTimersByTime(2000)
    }
    expect(lastTurn()).toMatchObject({ state: 'error', error: '该网站上一条写入命令还没结束' })
    expect(state().activeRunId).toBeNull()
  })
})
