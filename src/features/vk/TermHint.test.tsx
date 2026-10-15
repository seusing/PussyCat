import type { ReactNode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KNOWN_TERMS_KEY, addKnownTerm, loadKnownTerms } from '../../data/knownTerms'
import { TermHint, TermHintMarkdown } from './TermHint'
import type { VkTermHint } from './termHints'

const hint: VkTermHint = {
  term: '渐进式超负荷',
  explanation: '逐步增加训练负荷，让身体持续适应变强',
  in_video: '这里指八乘八做满后每次加 2.5 公斤',
}

const cardName = '术语：渐进式超负荷'
const queryCard = () => screen.queryByRole('dialog', { name: cardName })
const findCard = () => screen.findByRole('dialog', { name: cardName })
const waitForCardGone = () => waitFor(() => expect(queryCard()).not.toBeInTheDocument())
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// 结果窗口自己监听 Esc 来整个关掉;术语卡片的 Esc 不能传到这里。
function Window({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <section role="dialog" aria-label="结果窗口" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
      {children}
    </section>
  )
}

function renderHint(props: { note?: string | null; onKnown?: (term: string) => void; hint?: VkTermHint; onClose?: () => void } = {}) {
  const onClose = props.onClose ?? vi.fn()
  const onKnown = props.onKnown ?? vi.fn()
  render(
    <Window onClose={onClose}>
      <p>先理解 <TermHint hint={props.hint ?? hint} note={props.note ?? null} onKnown={onKnown}>渐进式超负荷</TermHint> 再加量</p>
      <button type="button">其他控件</button>
    </Window>,
  )
  return { trigger: screen.getByRole('button', { name: '渐进式超负荷' }), onClose, onKnown }
}

describe('TermHint 触发点', () => {
  it('是可聚焦的按钮,打开后 aria-describedby 指向卡片', async () => {
    const { trigger } = renderHint()
    expect(trigger).toHaveClass('vk-term')
    expect(trigger).toHaveAttribute('tabindex', '0')
    expect(trigger).not.toHaveAttribute('aria-describedby')
    await userEvent.hover(trigger)
    const card = await findCard()
    expect(trigger).toHaveAttribute('aria-describedby', card.id)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('TermHint 卡片内容', () => {
  it('写术语、通俗解释和在这个视频里的含义', async () => {
    const { trigger } = renderHint()
    await userEvent.hover(trigger)
    const card = await findCard()
    expect(within(card).getByText('渐进式超负荷').tagName).toBe('STRONG')
    expect(card).toHaveTextContent('逐步增加训练负荷，让身体持续适应变强')
    expect(card).toHaveTextContent('在这个视频里：这里指八乘八做满后每次加 2.5 公斤')
    expect(card).not.toHaveTextContent('未经 Jev 筛选')
  })

  it('故事线术语写出处视频', async () => {
    const { trigger } = renderHint({ hint: { ...hint, job_id: 'job-2', video_title: '第二集' } })
    await userEvent.hover(trigger)
    expect(await findCard()).toHaveTextContent('在《第二集》里：这里指八乘八做满后每次加 2.5 公斤')
  })

  it('没有视频内含义时不写那一行,有 note 时底部带一行说明', async () => {
    const { trigger } = renderHint({ hint: { ...hint, in_video: '' }, note: '未经 Jev 筛选：HTTP 451' })
    await userEvent.hover(trigger)
    const card = await findCard()
    expect(card).not.toHaveTextContent('在这个视频里')
    expect(card).toHaveTextContent('未经 Jev 筛选：HTTP 451')
  })
})

describe('TermHint 打开与关闭', () => {
  it('悬停打开,离开 160ms 后关闭', async () => {
    const { trigger } = renderHint()
    await userEvent.hover(trigger)
    await findCard()
    await userEvent.unhover(trigger)
    expect(queryCard()).toBeInTheDocument()
    await waitForCardGone()
  })

  it('鼠标从术语移进卡片不会关', async () => {
    const { trigger } = renderHint()
    await userEvent.hover(trigger)
    const card = await findCard()
    await userEvent.unhover(trigger)
    await userEvent.hover(card)
    await sleep(350)
    expect(queryCard()).toBeInTheDocument()
    await userEvent.unhover(card)
    await waitForCardGone()
  })

  it('键盘聚焦打开,失焦关闭', async () => {
    const { trigger } = renderHint()
    await userEvent.tab()
    expect(trigger).toHaveFocus()
    await findCard()
    await userEvent.tab()
    await waitForCardGone()
  })

  it('点击固定:移开鼠标也不关,再点一次收起', async () => {
    const { trigger } = renderHint()
    await userEvent.click(trigger)
    await findCard()
    await userEvent.unhover(trigger)
    await sleep(350)
    expect(queryCard()).toBeInTheDocument()
    await userEvent.click(trigger)
    await waitForCardGone()
  })

  it('回车固定并把焦点交给「我已了解」', async () => {
    const { trigger } = renderHint()
    trigger.focus()
    const card = await findCard()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(within(card).getByRole('button', { name: '我已了解' })).toHaveFocus())
    await sleep(350)
    expect(queryCard()).toBeInTheDocument()
  })

  it('点击卡片和术语之外的地方关闭固定的卡片,点卡片内部不关', async () => {
    const { trigger } = renderHint()
    await userEvent.click(trigger)
    const card = await findCard()
    await userEvent.click(within(card).getByText('逐步增加训练负荷，让身体持续适应变强'))
    expect(queryCard()).toBeInTheDocument()
    await userEvent.click(document.body)
    await waitForCardGone()
  })
})

describe('TermHint 的 Esc', () => {
  it('悬停打开时按 Esc 只关卡片,不关结果窗口', async () => {
    const { trigger, onClose } = renderHint()
    screen.getByRole('dialog', { name: '结果窗口' }).focus()
    await userEvent.hover(trigger)
    await findCard()
    await userEvent.keyboard('{Escape}')
    await waitForCardGone()
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('焦点在卡片里按 Esc 关卡片、焦点回术语,卡片不会因此重新打开', async () => {
    const { trigger, onClose } = renderHint()
    trigger.focus()
    const card = await findCard()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(within(card).getByRole('button', { name: '我已了解' })).toHaveFocus())
    await userEvent.keyboard('{Escape}')
    await waitForCardGone()
    expect(trigger).toHaveFocus()
    await sleep(350)
    expect(queryCard()).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('卡片关着时 Esc 照常传给结果窗口', async () => {
    const { onClose } = renderHint()
    screen.getByRole('dialog', { name: '结果窗口' }).focus()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('我已了解', () => {
  it('把术语交给 onKnown 并收起卡片', async () => {
    const { trigger, onKnown } = renderHint()
    await userEvent.hover(trigger)
    await userEvent.click(within(await findCard()).getByRole('button', { name: '我已了解' }))
    expect(onKnown).toHaveBeenCalledWith('渐进式超负荷')
    await waitForCardGone()
  })

  it('写入存储,当前笔记里这个词的下划线消失而文字保留', async () => {
    const { container } = render(<TermHintMarkdown terms={[hint]} note={null}>{'练习要遵循渐进式超负荷,每周加一点。'}</TermHintMarkdown>)
    await userEvent.hover(screen.getByRole('button', { name: '渐进式超负荷' }))
    await userEvent.click(within(await findCard()).getByRole('button', { name: '我已了解' }))

    expect(loadKnownTerms().has('渐进式超负荷')).toBe(true)
    expect(container.querySelector('.vk-term')).toBeNull()
    expect(container).toHaveTextContent('练习要遵循渐进式超负荷,每周加一点。')
    await waitForCardGone()
  })

  it('之后新打开的笔记不再标这个词', () => {
    addKnownTerm('渐进式超负荷')
    const { container } = render(<TermHintMarkdown terms={[hint]} note={null}>{'练习要遵循渐进式超负荷'}</TermHintMarkdown>)
    expect(container.querySelector('.vk-term')).toBeNull()
  })

  it('拉丁字母术语按规范化后的写法记忆', async () => {
    const rpe: VkTermHint = { term: 'RPE', explanation: '主观用力程度', in_video: '这里指 8 分' }
    const { container } = render(<TermHintMarkdown terms={[rpe]} note={null}>{'先看 rpe 再看 RPE'}</TermHintMarkdown>)
    await userEvent.hover(screen.getByRole('button', { name: 'rpe' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: '术语：RPE' })).getByRole('button', { name: '我已了解' }))
    expect(JSON.parse(localStorage.getItem(KNOWN_TERMS_KEY)!)).toEqual(['rpe'])
    expect(container.querySelector('.vk-term')).toBeNull()
  })

  it('点掉一个词后,名额让给下一个出现在笔记里的词', async () => {
    const terms = ['甲术语', '乙术语', '丙术语'].map((term) => ({ term, explanation: `${term}解释`, in_video: '' }))
    const { container } = render(<TermHintMarkdown terms={terms} note={null}>{'丙术语、乙术语、甲术语'}</TermHintMarkdown>)
    const marked = () => [...container.querySelectorAll('.vk-term')].map((element) => element.textContent)
    expect(marked()).toEqual(['丙术语', '乙术语', '甲术语'])
    await userEvent.hover(screen.getByRole('button', { name: '乙术语' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: '术语：乙术语' })).getByRole('button', { name: '我已了解' }))
    expect(marked()).toEqual(['丙术语', '甲术语'])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
