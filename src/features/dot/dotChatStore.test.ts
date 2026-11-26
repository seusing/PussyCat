import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DoneEvent, HostBridge, OutputEvent, RunRequest } from '../../host/types'
import { connectDotHistory, resetDotHistoryForTests, selectActiveConversation, selectLiveConversationId, useDotChat } from './dotChatStore'
import type { DotHistoryFile, DotHistoryPersistence } from './dotHistory'

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
const activeTurns = () => selectActiveConversation(state())?.turns ?? []
const lastTurn = () => activeTurns()[activeTurns().length - 1]

beforeEach(() => {
  resetDotHistoryForTests()
  useDotChat.setState({ conversations: [], activeId: null, activeRunId: null, host: null })
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

  it('重新生成:去掉最后一问,原样再问一次', () => {
    const { host, started } = fakeHost()
    state().bindHost(host)
    state().ask('问题')
    state().handleOutput(out(started[0].runId, line({ type: 'start', conversationId: 'c1', messageId: 'm1' })))
    state().handleDone(done(started[0].runId, 'success'))
    state().regenerate()
    expect(activeTurns()).toHaveLength(1)
    expect(started[1].argv.slice(0, 5)).toEqual(['xiaohongshu-dot', 'chat', '问题', '--conversation', 'c1'])
  })

  it('点点正被视频解析占用:这一问自动排队,隔一会儿用同一个问题、同一个会话再试', () => {
    vi.useFakeTimers()
    const { host, started } = fakeHost()
    state().bindHost(host)
    useDotChat.setState({ conversations: [{ id: 'local', remoteId: 'c1', title: '旧问题', createdAt: 1, updatedAt: 1, turns: [] }], activeId: 'local' })
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

  it('对话:第一问建对话(标题是第一问),新对话另起一个,切回旧对话接着它的会话问', () => {
    const { host, started } = fakeHost()
    state().bindHost(host)
    state().ask('  周末   去哪玩 ')
    const first = state().activeId
    expect(selectActiveConversation(state())).toMatchObject({ title: '周末 去哪玩', remoteId: null })
    state().handleOutput(out(started[0].runId, line({ type: 'start', conversationId: 'dot-a', messageId: 'm1' })))
    state().handleDone(done(started[0].runId, 'success'))

    state().newConversation()
    expect(state().activeId).toBeNull()
    expect(activeTurns()).toEqual([])
    state().ask('剪辑技巧')
    expect(started[1].argv).not.toContain('--conversation')
    expect(state().conversations).toHaveLength(2)
    state().handleDone(done(started[1].runId, 'success'))

    state().openConversation(first!)
    state().ask('再推荐几个')
    expect(started[2].argv.slice(3, 5)).toEqual(['--conversation', 'dot-a'])
    expect(activeTurns().map((turn) => turn.question)).toEqual(['周末   去哪玩', '再推荐几个'])
  })

  it('回答途中切到别的对话:后到的内容照样落在原来那个对话里', () => {
    const { host, started } = fakeHost()
    state().bindHost(host)
    state().ask('旧问题')
    state().handleDone(done(started[0].runId, 'success'))
    const older = state().activeId!
    state().newConversation()
    state().ask('新问题')
    const newer = state().activeId!
    expect(selectLiveConversationId(state())).toBe(newer)

    state().openConversation(older)
    state().handleOutput(out(started[1].runId, line({ type: 'delta', text: '新回答' })))
    state().handleDone(done(started[1].runId, 'success'))
    expect(state().conversations.find((item) => item.id === newer)?.turns[0]).toMatchObject({ answer: '新回答', state: 'done' })
    expect(activeTurns().map((turn) => turn.answer)).toEqual([''])
    expect(selectLiveConversationId(state())).toBeNull()
  })

  it('记下提问、第一段正文、答完的时刻,以及点点给的「接着问」', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { host, started } = fakeHost()
    state().bindHost(host)
    state().ask('问')
    vi.setSystemTime(4_200)
    state().handleOutput(out(started[0].runId, line({ type: 'delta', text: '答' })))
    vi.setSystemTime(9_000)
    state().handleOutput(out(started[0].runId, line({ type: 'done', sourceTotal: '', interrupted: false, followUps: ['再说说'] })))
    expect(lastTurn()).toMatchObject({ startedAt: 1_000, answeredAt: 4_200, finishedAt: 9_000, followUps: ['再说说'], state: 'done' })
  })
})

describe('对话记录存档', () => {
  const stored: DotHistoryFile = {
    version: 1,
    conversations: [{
      id: 'old', remoteId: 'dot-old', title: '旧对话', createdAt: 1, updatedAt: 5,
      turns: [
        { id: 't1', question: '旧对话', answer: '答完了', steps: [], references: [], sourceTotal: '', followUps: [], state: 'done', startedAt: 1 },
        { id: 't2', question: '关应用时还在答', answer: '一半', steps: [], references: [], sourceTotal: '', followUps: [], state: 'streaming', startedAt: 2 },
      ],
    }],
  }

  function fakePersistence(load: () => Promise<{ exists: boolean; history: unknown }>) {
    const saved: DotHistoryFile[] = []
    const persistence: DotHistoryPersistence = { load: vi.fn(load), save: vi.fn(async (history) => { saved.push(history) }) }
    return { persistence, saved }
  }

  it('读回存档:还在答的一轮定格成已停止;读回期间新问的对话一起留下并写回', async () => {
    vi.useFakeTimers()
    const { host } = fakeHost()
    state().bindHost(host)
    let release!: (value: { exists: boolean; history: unknown }) => void
    const { persistence, saved } = fakePersistence(() => new Promise((resolve) => { release = resolve }))
    connectDotHistory(persistence)
    expect(state().history.phase).toBe('loading')
    state().ask('读回前问的')

    release({ exists: true, history: stored })
    await vi.waitFor(() => expect(state().history.phase).toBe('ready'))
    expect(state().conversations.map((item) => item.id)[0]).toBe('old')
    expect(state().conversations[0].turns[1]).toMatchObject({ state: 'stopped', answer: '一半' })
    expect(state().conversations).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(10)
    expect(saved).toHaveLength(1)
    expect(saved[0].conversations.map((item) => item.title)).toEqual(['旧对话', '读回前问的'])
    expect(JSON.stringify(saved[0])).not.toMatch(/runId|busyRetries/)
  })

  it('改动去抖后整份写回;回答一直在流式到达时最多攒 4 秒', async () => {
    vi.useFakeTimers()
    const { host, started } = fakeHost()
    state().bindHost(host)
    const { persistence, saved } = fakePersistence(async () => ({ exists: false, history: null }))
    connectDotHistory(persistence)
    await vi.waitFor(() => expect(state().history.phase).toBe('ready'))

    state().ask('问')
    for (let index = 0; index < 30; index += 1) {
      state().handleOutput(out(started[0].runId, line({ type: 'delta', text: '字' })))
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(saved.length).toBeGreaterThanOrEqual(1)
    const before = saved.length
    state().handleDone(done(started[0].runId, 'success'))
    await vi.advanceTimersByTimeAsync(800)
    expect(saved.length).toBe(before + 1)
    expect(saved.at(-1)!.conversations[0].turns[0]).toMatchObject({ state: 'done', answer: '字'.repeat(30) })
  })

  it('读不出来:不写回(免得盖掉文件),可以重试', async () => {
    vi.useFakeTimers()
    const { host } = fakeHost()
    state().bindHost(host)
    let fail = true
    const { persistence, saved } = fakePersistence(async () => {
      if (fail) throw new Error('点点对话记录文件无法解析')
      return { exists: true, history: stored }
    })
    connectDotHistory(persistence)
    await vi.waitFor(() => expect(state().history.phase).toBe('error'))
    expect(state().history.error).toContain('无法解析')
    state().ask('问')
    await vi.advanceTimersByTimeAsync(5000)
    expect(saved).toHaveLength(0)

    fail = false
    state().retryHistory()
    await vi.waitFor(() => expect(state().history.phase).toBe('ready'))
    expect(state().conversations.map((item) => item.id)).toContain('old')
  })
})
