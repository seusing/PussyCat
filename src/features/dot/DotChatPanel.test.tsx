import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostBridge, RunRequest } from '../../host/types'
import { useAppStore } from '../../store/appStore'
import { DotChatPanel } from './DotChatPanel'
import { resetDotHistoryForTests, useDotChat } from './dotChatStore'
import { nextReveal } from './useTypewriter'

const line = (event: Record<string, unknown>) => `@@zz-dot ${JSON.stringify(event)}`
let seq = 0
const emit = (runId: string, event: Record<string, unknown>) => act(() => {
  useDotChat.getState().handleOutput({ runId, seq: seq++, at: 0, stream: 'stderr', text: line(event) })
})
const finish = (runId: string) => act(() => {
  useDotChat.getState().handleDone({ runId, at: 0, outcome: 'success' })
})
// 一问一答走完:开始 → 正文 → 结束
const answer = (runId: string, text: string, extra: Record<string, unknown> = {}) => {
  emit(runId, { type: 'start', conversationId: `remote-${runId}`, messageId: 'm' })
  emit(runId, { type: 'delta', text })
  emit(runId, { type: 'done', sourceTotal: '', interrupted: false, ...extra })
  finish(runId)
}

function setup() {
  const started: RunRequest[] = []
  const host: HostBridge = {
    startCommand: vi.fn(async (req: RunRequest) => { started.push(req); return { runId: req.runId } }),
    cancelCommand: vi.fn(async () => {}),
    onOutput: () => () => {},
    onDone: () => () => {},
  }
  resetDotHistoryForTests()
  useDotChat.setState({ conversations: [], activeId: null, activeRunId: null, host })
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

  it('回车发送;没出字前是像素格 + 当前步骤 + 计时,出字后收成一行;答完可重新生成', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '我有几个收藏夹？{Enter}')
    expect(screen.getByTestId('dot-chat-input')).toHaveValue('')
    const runId = started[0].runId
    expect(screen.getByTestId('dot-chat-stop')).toBeInTheDocument()
    expect(screen.queryByTestId('dot-chat-send')).toBeNull()
    const thinking = screen.getByTestId('dot-thinking')
    expect(thinking).toHaveTextContent('点点正在想')
    expect(thinking).toHaveTextContent(/\d+\.\ds$/)

    emit(runId, { type: 'start', conversationId: 'c1', messageId: 'm1' })
    emit(runId, { type: 'status', text: '正在查看你的收藏' })
    expect(screen.getByTestId('dot-thinking')).toHaveTextContent('正在查看你的收藏')
    emit(runId, { type: 'delta', text: '你有 **3 个**收藏夹' })
    await vi.waitFor(() => expect(screen.getByTestId('dot-answer')).toHaveTextContent('你有 3 个收藏夹'))
    expect(screen.queryByTestId('dot-thinking')).toBeNull()
    expect(screen.getByTestId('dot-steps').querySelector('summary')).toHaveTextContent(/^思考 \d+\.\ds$/)

    emit(runId, { type: 'done', sourceTotal: 'ai为你回答', interrupted: false })
    finish(runId)
    expect(screen.getByTestId('dot-chat-send')).toBeDisabled()
    expect(screen.getByTestId('dot-steps').querySelector('summary')).toHaveTextContent(/^思考 \d+\.\ds · ai为你回答$/)
    expect(screen.getByTestId('dot-answer').querySelector('.dot-word, .dot-caret')).toBeNull()
    await userEvent.click(screen.getByTestId('dot-regenerate'))
    expect(started[1].argv).toEqual(['xiaohongshu-dot', 'chat', '我有几个收藏夹？', '--conversation', 'c1', '--timeout', '180', '-f', 'json'])
  })

  it('生成中:正文按词拆开浮现,末尾有光标;没合上的粗体先不露星号', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '问{Enter}')
    emit(started[0].runId, { type: 'delta', text: '黄金连续两天暴跌，**原因' })
    const markdown = await screen.findByTestId('dot-answer')
    await vi.waitFor(() => expect(markdown).toHaveTextContent('黄金连续两天暴跌，原因'))
    expect(markdown.textContent).not.toContain('*')
    expect(markdown.querySelectorAll('.dot-word').length).toBeGreaterThan(3)
    expect(markdown.querySelector('strong .dot-word')).not.toBeNull()
    expect(markdown.querySelector('.dot-caret')).not.toBeNull()
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

  it('出处:动作行里显示作者头像和篇数,点开是笔记列表;视频笔记可送去视频解析', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '黄金怎么了{Enter}')
    const runId = started[0].runId
    emit(runId, { type: 'delta', text: '金价下跌' })
    emit(runId, { type: 'references', items: [VIDEO, { ...VIDEO, noteId: '69bbe9d8000000001a02e787', noteType: 'normal', title: '图文笔记', author: '小李' }] })
    emit(runId, { type: 'done', sourceTotal: '', interrupted: false })
    finish(runId)

    const toggle = screen.getByTestId('dot-sources-toggle')
    expect(toggle).toHaveTextContent('引用 2 篇笔记')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: '引用的笔记' })).toBeNull()
    await userEvent.click(toggle)
    expect(screen.getByRole('list', { name: '引用的笔记' })).toBeInTheDocument()

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

  it('回答里夹着的点点图片块显示成行内出处标签,在浏览器里打开;缩进的残行不显示成代码', async () => {
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

    const answerBlock = await screen.findByTestId('dot-answer')
    const link = await within(answerBlock).findByRole('link', { name: '配图 · 西岁' })
    expect(link).toHaveAttribute('href', 'https://www.xiaohongshu.com/explore/69ad4ff6000000002602ff78')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveClass('dot-chip')
    expect(link).toHaveTextContent('西西岁')
    expect(answerBlock.textContent).not.toMatch(/<\/?div|<img/)
    expect(answerBlock.querySelector('pre')).toBeNull()
  })

  it('点点给了「接着问」:列在最后一问下面,点了就在这个对话里接着问', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '周末去哪{Enter}')
    answer(started[0].runId, '去肇庆', { followUps: ['肇庆有什么好吃的', '一天来回够吗'] })
    const followUps = screen.getByRole('region', { name: '接着问' })
    await userEvent.click(within(followUps).getByRole('button', { name: '一天来回够吗' }))
    expect(started[1].argv.slice(2, 5)).toEqual(['一天来回够吗', '--conversation', `remote-${started[0].runId}`])
    expect(screen.queryByRole('region', { name: '接着问' })).toBeNull()
  })

  it('回答里有能比较的数字:下方出数据洞察,多张时可以翻', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '黄金为什么跌{Enter}')
    answer(started[0].runId, `| 城市 | 人均 |
| --- | --- |
| 肇庆 | 80 元 |
| 顺德 | 120 元 |

- **上调经济预期**：将长期潜在增速从 1.8% 上调至 2%。
- **上调通胀预期**：核心 PCE 预期从 2.5% 大幅上调至 2.7%。`)
    const insights = screen.getByTestId('dot-insights')
    expect(insights).toHaveTextContent('数据洞察1/2')
    expect(insights).toHaveTextContent('人均：顺德 最高（120 元），肇庆 最低（80 元）')
    await userEvent.click(within(insights).getByRole('button', { name: '下一条' }))
    expect(insights).toHaveTextContent('2 处前后变化里，长期潜在增速 变化最大：1.8% → 2%')
    expect(insights).toHaveTextContent('+0.2 个百分点')
  })

  it('没有能比较的数字时不出数据洞察', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '问{Enter}')
    answer(started[0].runId, '推荐这三条笔记：第1条讲画中画，第2条讲关键帧。')
    expect(screen.queryByTestId('dot-insights')).toBeNull()
  })

  it('对话记录:答完出现在左栏;新对话回到空白,点记录切回去;搜索按问题过滤', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '周末去哪{Enter}')
    answer(started[0].runId, '去肇庆')
    const history = screen.getByTestId('dot-history')
    expect(within(history).getByText('周末去哪')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('dot-new-conversation'))
    expect(screen.getByTestId('dot-chat-empty')).toBeInTheDocument()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '剪辑技巧{Enter}')
    answer(started[1].runId, '用关键帧')

    await userEvent.click(within(history).getByText('周末去哪'))
    expect(screen.getByTestId('dot-answer')).toHaveTextContent('去肇庆')
    expect(within(history).getByText('周末去哪').closest('button')).toHaveAttribute('aria-current', 'true')

    await userEvent.click(within(history).getByRole('button', { name: '搜索对话' }))
    await userEvent.type(screen.getByTestId('dot-history-search'), '剪辑')
    expect(within(history).queryByText('周末去哪')).toBeNull()
    expect(within(history).getByText('剪辑技巧')).toBeInTheDocument()
    await userEvent.type(screen.getByTestId('dot-history-search'), '没有的{Escape}')
    expect(within(history).getByText('周末去哪')).toBeInTheDocument()
  })

  it('点点在别的对话里答着:这边不能发送、也没有停止按钮;回到那个对话才能停', async () => {
    const { started } = setup()
    await userEvent.type(screen.getByTestId('dot-chat-input'), '旧问题{Enter}')
    answer(started[0].runId, '旧回答')
    await userEvent.click(screen.getByTestId('dot-new-conversation'))
    await userEvent.type(screen.getByTestId('dot-chat-input'), '新问题{Enter}')

    const history = screen.getByTestId('dot-history')
    await userEvent.click(within(history).getByText('旧问题'))
    await userEvent.type(screen.getByTestId('dot-chat-input'), '再问')
    expect(screen.queryByTestId('dot-chat-stop')).toBeNull()
    expect(screen.getByTestId('dot-chat-send')).toBeDisabled()
    expect(within(history).getByText('新问题').closest('button')?.querySelector('.dot-history-live')).not.toBeNull()

    await userEvent.click(within(history).getByText('新问题'))
    expect(screen.getByTestId('dot-chat-stop')).toBeInTheDocument()
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
