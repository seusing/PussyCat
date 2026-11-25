import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostBridge, RunRequest } from '../../host/types'
import { useAppStore } from '../../store/appStore'
import { DotChatPanel } from './DotChatPanel'
import { useDotChat } from './dotChatStore'
import { nextReveal } from './useTypewriter'

const line = (event: Record<string, unknown>) => `@@zz-dot ${JSON.stringify(event)}`
let seq = 0
const emit = (runId: string, event: Record<string, unknown>) => act(() => {
  useDotChat.getState().handleOutput({ runId, seq: seq++, at: 0, stream: 'stderr', text: line(event) })
})
const finish = (runId: string) => act(() => {
  useDotChat.getState().handleDone({ runId, at: 0, outcome: 'success' })
})

function setup() {
  const started: RunRequest[] = []
  const host: HostBridge = {
    startCommand: vi.fn(async (req: RunRequest) => { started.push(req); return { runId: req.runId } }),
    cancelCommand: vi.fn(async () => {}),
    onOutput: () => () => {},
    onDone: () => () => {},
  }
  useDotChat.setState({ turns: [], conversationId: null, activeRunId: null, host })
  render(<DotChatPanel />)
  return { started }
}

const VIDEO = {
  noteId: '69bbe9d8000000001a02e786', title: '黄金连续两天暴跌', author: '财经小王', noteType: 'video',
  url: 'https://www.xiaohongshu.com/explore/69bbe9d8000000001a02e786?xsec_token=AB1&xsec_source=pc_search', quote: '金价两天跌了 5%',
}

beforeEach(() => {
  useAppStore.setState({ vkHandoff: undefined, activeModule: 'dot' })
})

describe('DotChatPanel', () => {
  it('空状态一句话加一个示例问题,点了就问', async () => {
    const { started } = setup()
    const empty = screen.getByTestId('dot-chat-empty')
    expect(empty).toHaveTextContent('想问点点什么？')
    await userEvent.click(within(empty).getByRole('button'))
    expect(started[0].argv[2]).toBe('推荐几条讲手机剪辑技巧的视频笔记')
  })

  it('回车发送,流式显示过程和正文;生成中只能停止,答完可重新生成', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '我有几个收藏夹？{Enter}')
    expect(screen.getByTestId('dot-chat-input')).toHaveValue('')
    const runId = started[0].runId
    expect(screen.getByTestId('dot-chat-stop')).toBeInTheDocument()
    expect(screen.queryByTestId('dot-chat-send')).toBeNull()
    expect(screen.getByText('点点正在想…')).toBeInTheDocument()

    emit(runId, { type: 'start', conversationId: 'c1', messageId: 'm1' })
    emit(runId, { type: 'status', text: '正在查看你的收藏' })
    expect(screen.getByTestId('dot-steps')).toHaveTextContent('正在查看你的收藏')
    emit(runId, { type: 'delta', text: '你有 **3 个**收藏夹' })
    expect(await screen.findByText('3 个')).toBeInTheDocument()

    emit(runId, { type: 'done', sourceTotal: 'ai为你回答', interrupted: false })
    finish(runId)
    expect(screen.getByTestId('dot-chat-send')).toBeDisabled()
    expect(screen.getByTestId('dot-steps')).toHaveTextContent('ai为你回答')
    await userEvent.click(screen.getByTestId('dot-regenerate'))
    expect(started[1].argv).toEqual(['xiaohongshu-dot', 'chat', '我有几个收藏夹？', '--conversation', 'c1', '--timeout', '180', '-f', 'json'])
  })

  it('Shift+Enter 换行不发送', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '第一行{Shift>}{Enter}{/Shift}第二行')
    expect(started).toHaveLength(0)
    expect(screen.getByTestId('dot-chat-input')).toHaveValue('第一行\n第二行')
  })

  it('停止:立刻标出已停止,并调点点自己的停止', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '长问题{Enter}')
    emit(started[0].runId, { type: 'delta', text: '答了一半' })
    await userEvent.click(screen.getByTestId('dot-chat-stop'))
    expect(screen.getByTestId('dot-stopped')).toBeInTheDocument()
    expect(screen.getByText('答了一半')).toBeInTheDocument()
    expect(started[1].commandKey).toBe('xiaohongshu-dot/stop')
  })

  it('引用卡片默认折叠,点开看摘录;视频笔记可送去视频解析', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '黄金怎么了{Enter}')
    const runId = started[0].runId
    emit(runId, { type: 'delta', text: '金价下跌' })
    emit(runId, { type: 'references', items: [VIDEO, { ...VIDEO, noteId: '69bbe9d8000000001a02e787', noteType: 'normal', title: '图文笔记' }] })
    emit(runId, { type: 'done', sourceTotal: '', interrupted: false })
    finish(runId)

    expect(screen.getByText('引用 2 篇笔记')).toBeInTheDocument()
    const card = screen.getByTestId(`dot-ref-${VIDEO.noteId}`)
    expect(within(card).queryByText(VIDEO.quote)).toBeNull()
    await userEvent.click(within(card).getByRole('button', { expanded: false }))
    expect(within(card).getByText(VIDEO.quote)).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: '打开原文' })).toHaveAttribute('href', VIDEO.url)

    const imageCard = screen.getByTestId('dot-ref-69bbe9d8000000001a02e787')
    await userEvent.click(within(imageCard).getByRole('button', { expanded: false }))
    expect(within(imageCard).queryByText('送去视频解析')).toBeNull()

    await userEvent.click(within(card).getByTestId(`dot-ref-send-${VIDEO.noteId}`))
    expect(useAppStore.getState().vkHandoff).toMatchObject({ url: VIDEO.url, commandKey: 'xiaohongshu-dot/chat' })
    expect(useAppStore.getState().activeModule).toBe('vk')
  })

  it('回答里夹着的点点图片块显示成笔记链接,在浏览器里打开;缩进的残行不显示成代码', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '周末去哪{Enter}')
    const runId = started[0].runId
    const image = `<div class="ai-msg-image-item" data-index="1">
  <img
    src="http://sns-note-i4.xhscdn.com/a"
    data-noteId="69ad4ff6000000002602ff78"
    data-sourceNickname="西岁"
  />
</div>`
    emit(runId, { type: 'delta', text: `**肇庆**：高铁约1小时。
</div>

${image}

    缩进的一行` })
    emit(runId, { type: 'done', sourceTotal: '', interrupted: false })
    finish(runId)

    const answer = await screen.findByTestId('dot-answer')
    const link = await within(answer).findByRole('link', { name: '配图 · 西岁' })
    expect(link).toHaveAttribute('href', 'https://www.xiaohongshu.com/explore/69ad4ff6000000002602ff78')
    expect(link).toHaveAttribute('target', '_blank')
    expect(answer.textContent).not.toMatch(/<\/?div|<img/)
    expect(answer.querySelector('pre')).toBeNull()
  })

  it('出错时显示原因', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '问{Enter}')
    emit(started[0].runId, { type: 'error', message: '点点页面被刷新，这条回答中断了' })
    expect(screen.getByRole('alert')).toHaveTextContent('点点页面被刷新，这条回答中断了')
  })
})

describe('nextReveal', () => {
  it('按时间匀速放字,积压越多越快,不超过已收到的长度', () => {
    expect(nextReveal(0, 10, 16, true)).toBeGreaterThanOrEqual(1)
    const slow = nextReveal(0, 20, 100, true)
    const fast = nextReveal(0, 400, 100, true)
    expect(fast).toBeGreaterThan(slow)
    expect(nextReveal(5, 8, 10_000, true)).toBe(8)
    expect(nextReveal(8, 8, 16, true)).toBe(8)
  })

  it('回答结束后加速收尾', () => {
    expect(nextReveal(0, 200, 100, false)).toBeGreaterThan(nextReveal(0, 200, 100, true))
  })
})
