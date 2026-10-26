import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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

describe('TermHintMarkdown 语法', () => {
  it('开头的 YAML 头只解析不渲染', () => {
    const { container } = render(
      <TermHintMarkdown terms={[]} note={null}>{'---\nsource_id: abc123\ntitle: 装修日记\n---\n\n# 正文标题\n\n第一段'}</TermHintMarkdown>,
    )
    expect(container).not.toHaveTextContent('source_id:')
    expect(container.querySelector('hr')).toBeNull()
    expect(screen.getByRole('heading', { name: '正文标题' })).toBeInTheDocument()
    expect(screen.getByText('第一段')).toBeInTheDocument()
  })

  it('行尾的 HTML 注释不显示', () => {
    const { container } = render(
      <TermHintMarkdown terms={[]} note={null}>{'- 先量尺寸再下单 <!-- claim_id: c_01 -->'}</TermHintMarkdown>,
    )
    expect(container).toHaveTextContent('先量尺寸再下单')
    expect(container).not.toHaveTextContent('claim_id')
    expect(container).not.toHaveTextContent('<!--')
  })

  it('GFM 两栏表渲染成表格', () => {
    render(
      <TermHintMarkdown terms={[]} note={null}>{'| 观察什么 | 视频怎么看 |\n| --- | --- |\n| 报价单 | 先看有没有漏项 |'}</TermHintMarkdown>,
    )
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '观察什么' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '视频怎么看' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '先看有没有漏项' })).toBeInTheDocument()
  })

  it('表格单元格里的术语照常挂卡片', async () => {
    render(
      <TermHintMarkdown terms={[hint]} note={null}>{'| 观察什么 | 视频怎么看 |\n| --- | --- |\n| 渐进式超负荷 | 每周加一点 |'}</TermHintMarkdown>,
    )
    const trigger = within(screen.getByRole('cell', { name: '渐进式超负荷' })).getByRole('button', { name: '渐进式超负荷' })
    await userEvent.hover(trigger)
    expect(await findCard()).toHaveTextContent('逐步增加训练负荷')
  })

  it('img 的 data:image 地址能显示,其他 data: 和 javascript: 仍被拦', () => {
    const { container } = render(
      <TermHintMarkdown terms={[]} note={null}>
        {'![内联图](data:image/jpeg;base64,/9j/4AAQ+=)\n\n![脚本图](data:text/html;base64,PHNjcmlwdD4=)\n\n[点我](javascript:alert(1))'}
      </TermHintMarkdown>,
    )
    expect(screen.getByAltText('内联图')).toHaveAttribute('src', 'data:image/jpeg;base64,/9j/4AAQ+=')
    expect(screen.getByAltText('脚本图').getAttribute('src') ?? '').toBe('')
    expect(screen.getByText('点我').closest('a')?.getAttribute('href') ?? '').toBe('')
    expect(container.innerHTML).not.toContain('javascript:')
  })

  it('data:image 只对 img 的 src 放行,链接的 href 不行', () => {
    render(<TermHintMarkdown terms={[]} note={null}>{'[点我](data:image/png;base64,AAAA)'}</TermHintMarkdown>)
    expect(screen.getByText('点我').closest('a')?.getAttribute('href') ?? '').toBe('')
  })
})

describe('TermHintMarkdown 配图', () => {
  const NAME = '0123456789ab'
  const ALT = '镜头里的接缝（01:23）'
  const note = `- 关键点\n  ![${ALT}](figures/${NAME}.jpg)`
  let objectUrls = 0
  const createObjectURL = vi.fn(() => `blob:figure-${++objectUrls}`)
  const revokeObjectURL = vi.fn()

  function stubFigureFetch(ok = true) {
    const fetchMock = vi.fn(async () => (ok ? new Response(new Blob(['jpg'], { type: 'image/jpeg' })) : new Response('missing', { status: 404 })))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  beforeEach(() => {
    objectUrls = 0
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
  })
  afterEach(() => {
    cleanup()   // 卸载要在对象 URL 方法还在时发生
    Reflect.deleteProperty(URL, 'createObjectURL')
    Reflect.deleteProperty(URL, 'revokeObjectURL')
  })

  it('fetch 取回 blob,以对象 URL 显示并带图注', async () => {
    const fetchMock = stubFigureFetch()
    const { container } = render(<TermHintMarkdown terms={[]} note={null} figureJobId="run:r1" baseUrl="http://host">{note}</TermHintMarkdown>)
    const image = await screen.findByAltText(ALT)
    expect(image).toHaveAttribute('src', 'blob:figure-1')
    expect(fetchMock).toHaveBeenCalledWith(`http://host/vk/v1/outputs/run:r1/figure-${NAME}`)
    const figure = container.querySelector('span.vk-figure')!
    expect(figure.querySelector('img')).toBe(image)
    expect(figure.querySelector('.vk-figure-caption')).toHaveTextContent(ALT)
  })

  it('加载中先显示占位', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<TermHintMarkdown terms={[]} note={null} figureJobId="job-1" baseUrl="http://host">{note}</TermHintMarkdown>)
    expect(await screen.findByText('配图加载中…')).toBeInTheDocument()
  })

  it('取图失败显示「配图加载失败」', async () => {
    stubFigureFetch(false)
    render(<TermHintMarkdown terms={[]} note={null} figureJobId="job-1" baseUrl="http://host">{note}</TermHintMarkdown>)
    expect(await screen.findByText('配图加载失败')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('卸载时释放对象 URL', async () => {
    stubFigureFetch()
    const { unmount } = render(<TermHintMarkdown terms={[]} note={null} figureJobId="job-1" baseUrl="http://host">{note}</TermHintMarkdown>)
    await screen.findByAltText(ALT)
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:figure-1')
  })

  it('图片地址变化时释放旧的对象 URL 并取新图', async () => {
    const fetchMock = stubFigureFetch()
    const { rerender } = render(<TermHintMarkdown terms={[]} note={null} figureJobId="job-1" baseUrl="http://host">{note}</TermHintMarkdown>)
    await screen.findByAltText(ALT)
    rerender(<TermHintMarkdown terms={[]} note={null} figureJobId="job-1" baseUrl="http://host">{'![另一张](figures/ffffffffffff.jpg)'}</TermHintMarkdown>)
    expect(await screen.findByAltText('另一张')).toHaveAttribute('src', 'blob:figure-2')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:figure-1')
    expect(fetchMock).toHaveBeenLastCalledWith('http://host/vk/v1/outputs/job-1/figure-ffffffffffff')
  })

  it('没有 figureJobId 时 figures/ 引用按普通图片渲染,不发请求', () => {
    const fetchMock = stubFigureFetch()
    render(<TermHintMarkdown terms={[]} note={null}>{note}</TermHintMarkdown>)
    expect(screen.getByAltText(ALT)).toHaveAttribute('src', `figures/${NAME}.jpg`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('不符合 figures/<12 位十六进制>.jpg 的图片照常渲染,不发请求', () => {
    const fetchMock = stubFigureFetch()
    render(<TermHintMarkdown terms={[]} note={null} figureJobId="job-1">{'![别的图](figures/xyz.jpg)\n\n![外链](https://example.com/a.png)'}</TermHintMarkdown>)
    expect(screen.getByAltText('别的图')).toHaveAttribute('src', 'figures/xyz.jpg')
    expect(screen.getByAltText('外链')).toHaveAttribute('src', 'https://example.com/a.png')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('点配图打开挂在 body 上的灯箱,Esc 或点击关闭,Esc 不会传给外层窗口', async () => {
    stubFigureFetch()
    const onClose = vi.fn()
    render(
      <Window onClose={onClose}>
        <TermHintMarkdown terms={[]} note={null} figureJobId="job-1" baseUrl="http://host">{note}</TermHintMarkdown>
      </Window>,
    )
    const figure = await screen.findByRole('button', { name: `查看大图：${ALT}` })
    await userEvent.click(figure)
    const lightbox = screen.getByRole('dialog', { name: ALT })
    expect(lightbox.parentElement).toBe(document.body)
    expect(within(lightbox).getByRole('img')).toHaveAttribute('src', 'blob:figure-1')

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: ALT })).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(figure).toHaveFocus()

    await userEvent.click(figure)
    await userEvent.click(screen.getByRole('dialog', { name: ALT }).querySelector('.yarl__slide')!)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: ALT })).not.toBeInTheDocument())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('键盘 Enter 也能打开灯箱', async () => {
    stubFigureFetch()
    render(<TermHintMarkdown terms={[]} note={null} figureJobId="job-1" baseUrl="http://host">{note}</TermHintMarkdown>)
    const figure = await screen.findByRole('button', { name: `查看大图：${ALT}` })
    figure.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('dialog', { name: ALT })).toBeInTheDocument()
  })

  describe('图集', () => {
    const FIGURES = [
      ['aaaaaaaaaaaa', '第一张（00:10）'],
      ['bbbbbbbbbbbb', '第二张（00:20）'],
      ['cccccccccccc', '第三张（00:30）'],
    ] as const
    const gallery = FIGURES.map(([name, alt]) => `- 关键点\n  ![${alt}](figures/${name}.jpg)`).join('\n')

    async function renderGallery(onClose = vi.fn()) {
      stubFigureFetch()
      render(
        <Window onClose={onClose}>
          <TermHintMarkdown terms={[]} note={null} figureJobId="job-1" baseUrl="http://host">{gallery}</TermHintMarkdown>
        </Window>,
      )
      const thumbnails = await Promise.all(FIGURES.map(([, alt]) => screen.findByAltText(alt)))
      return { onClose, thumbnails }
    }
    const currentSlide = () => {
      const slide = screen.getByRole('dialog').querySelector('.yarl__slide_current')!
      return slide.querySelector('img')!
    }

    it('配图显示为带图注的缩略图,不自动打开灯箱', async () => {
      const { thumbnails } = await renderGallery()
      expect(thumbnails).toHaveLength(3)
      for (const [, alt] of FIGURES) expect(screen.getByRole('button', { name: `查看大图：${alt}` })).toBeInTheDocument()
      expect(screen.queryByRole('dialog', { name: /第.张/ })).not.toBeInTheDocument()
    })

    it('从点开的那张起翻页,同一篇笔记的配图左右连着翻,标题跟着当前这张', async () => {
      const { thumbnails } = await renderGallery()
      await userEvent.click(screen.getByRole('button', { name: `查看大图：${FIGURES[1][1]}` }))

      const dialog = screen.getByRole('dialog', { name: FIGURES[1][1] })
      expect(dialog.parentElement).toBe(document.body)
      expect(currentSlide()).toHaveAttribute('src', thumbnails[1].getAttribute('src'))

      await userEvent.click(within(dialog).getByRole('button', { name: '下一张' }))
      await waitFor(() => expect(screen.getByRole('dialog', { name: FIGURES[2][1] })).toBeInTheDocument())
      expect(currentSlide()).toHaveAttribute('src', thumbnails[2].getAttribute('src'))
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: '下一张' })).toBeDisabled()

      await userEvent.keyboard('{ArrowLeft}{ArrowLeft}')
      await waitFor(() => expect(screen.getByRole('dialog', { name: FIGURES[0][1] })).toBeInTheDocument())
      expect(currentSlide()).toHaveAttribute('src', thumbnails[0].getAttribute('src'))
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: '上一张' })).toBeDisabled()
    })

    it('灯箱带缩放按钮,Esc 只关灯箱、不传给外层窗口,焦点回到点开的那张', async () => {
      const { onClose } = await renderGallery()
      const opener = screen.getByRole('button', { name: `查看大图：${FIGURES[2][1]}` })
      await userEvent.click(opener)
      const dialog = screen.getByRole('dialog', { name: FIGURES[2][1] })
      expect(within(dialog).getByRole('button', { name: '放大' })).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: '缩小' })).toBeInTheDocument()

      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('dialog', { name: FIGURES[2][1] })).not.toBeInTheDocument()
      expect(onClose).not.toHaveBeenCalled()
      expect(opener).toHaveFocus()
    })

    it('还没取回的配图不进图集,只翻已经能看的', async () => {
      const blob = new Blob(['jpg'], { type: 'image/jpeg' })
      vi.stubGlobal('fetch', vi.fn(async (url: string) => (
        url.endsWith('figure-bbbbbbbbbbbb') ? new Promise<Response>(() => {}) : new Response(blob)
      )))
      render(<TermHintMarkdown terms={[]} note={null} figureJobId="job-1" baseUrl="http://host">{gallery}</TermHintMarkdown>)
      await screen.findByAltText(FIGURES[0][1])
      await screen.findByAltText(FIGURES[2][1])
      await userEvent.click(screen.getByRole('button', { name: `查看大图：${FIGURES[0][1]}` }))
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '下一张' }))
      await waitFor(() => expect(screen.getByRole('dialog', { name: FIGURES[2][1] })).toBeInTheDocument())
    })
  })
})
