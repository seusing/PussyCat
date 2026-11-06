import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AnnotatedFigure } from './AnnotatedFigure'
import { fetchVkFigure } from '../../host/vkClient'
import { HostRequestError } from '../../host/errors'

vi.mock('../../host/vkClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../host/vkClient')>()),
  fetchVkFigure: vi.fn(),
}))

const NAME = '3fa9c1d2e4b5'
const BLOCK = [
  `::screenshot{src="figures/${NAME}.jpg" alt="图3" viewport="1080x1440"}`,
  ':::annotation{x=6.5 y=20.5 w=72.2 h=5.3 mark="underline" color="red"}',
  '投入 18 万 → 24.6 万，浮盈约 37%',
  ':::',
  ':::annotation{x=6.5 y=30.9 w=73.1 h=5.4 mark="circle" color="red" side="right"}',
  '年化 10.2% 含分红再投入，别和价格涨幅混着比',
  ':::',
  '::',
  '',
].join('\n')
const JPEG_DATA_URL = 'data:image/jpeg;base64,anBn'   // 'jpg' 的 base64

let objectUrls = 0

beforeEach(() => {
  objectUrls = 0
  Object.assign(URL, { createObjectURL: vi.fn(() => `blob:figure-${++objectUrls}`), revokeObjectURL: vi.fn() })
  vi.mocked(fetchVkFigure).mockReset().mockImplementation(async () => new Blob(['jpg'], { type: 'image/jpeg' }))
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
})

describe('AnnotatedFigure 渲染', () => {
  it('取回原图换成 data URL,渲染出批注标记、编号和批注文字', async () => {
    const { container } = render(<AnnotatedFigure block={BLOCK} jobId="run:r1" baseUrl="http://host" />)
    await waitFor(() => expect(container.querySelector('.ca-mark')).toBeInTheDocument())

    expect(fetchVkFigure).toHaveBeenCalledWith('run:r1', NAME, 'http://host')
    const root = container.querySelector('.vk-annotated')!
    expect(root).toHaveClass('dark')
    expect(root.querySelectorAll('.ca-mark')).toHaveLength(2)
    expect(root.querySelector('.ca-mark.ca-underline svg path')).toBeInTheDocument()
    expect(root.querySelector('.ca-mark.ca-circle svg path')).toBeInTheDocument()
    expect(root.querySelectorAll('.ca-stamp').length).toBeGreaterThanOrEqual(2)
    expect(root.querySelector('.ca-callout')).toHaveTextContent('年化 10.2% 含分红再投入，别和价格涨幅混着比')
    expect(root.querySelector('.ca-arrow svg path')).toBeInTheDocument()
    expect(root.querySelector('.ca-notes li')).toHaveTextContent('投入 18 万 → 24.6 万，浮盈约 37%')
    expect(root.querySelector('.ca-mark')).toHaveAttribute('data-n', '1')
    expect(root.querySelector('.ca-mark')?.getAttribute('style')).toContain('left:6.5%')

    const image = within(root as HTMLElement).getByAltText('图3')
    expect(image).toHaveAttribute('src', JPEG_DATA_URL)
    expect(image).toHaveAttribute('width', '1080')
    expect(image).toHaveAttribute('height', '1440')
  })

  it('包自带的样式只注入一次到 head,输出里不带 style、script 和复制按钮', async () => {
    const { container } = render(<AnnotatedFigure block={BLOCK} jobId="run:r1" />)
    await waitFor(() => expect(container.querySelector('.ca-mark')).toBeInTheDocument())

    expect(container.querySelector('style, script, button')).not.toBeInTheDocument()
    // 按钮去掉后它的图标 svg 不能留下:留在 .ca-frame 里会把框撑高,批注按百分比定位就整体错位
    expect(container.querySelector('[class*="ca-copy"]')).not.toBeInTheDocument()
    expect(container.querySelector('.ca-frame')?.children[0]?.tagName).toBe('IMG')
    const styles = document.head.querySelectorAll('style[data-vk-annotate]')
    expect(styles).toHaveLength(1)
    expect(styles[0].textContent).toContain('.ca-mark')
    expect(styles[0].textContent).toContain('.ca-callout')
    expect(styles[0].textContent).toContain('[data-zoom]')
  })

  it('渲染期间按 viewport 预留位置', async () => {
    let finish: (blob: Blob) => void = () => {}
    vi.mocked(fetchVkFigure).mockImplementation(() => new Promise<Blob>((resolve) => { finish = resolve }))
    const { container } = render(<AnnotatedFigure block={BLOCK} jobId="run:r1" />)
    const placeholder = container.querySelector<HTMLElement>('.vk-annotated-placeholder')!
    expect(placeholder).toHaveTextContent('配图加载中…')
    expect(placeholder.style.aspectRatio).toBe('1080 / 1440')

    finish(new Blob(['jpg'], { type: 'image/jpeg' }))
    await waitFor(() => expect(container.querySelector('.ca-mark')).toBeInTheDocument())
    expect(container.querySelector('.vk-annotated-placeholder')).not.toBeInTheDocument()
  })

  it('src 已是 data URL 时直接渲染,不再取图', async () => {
    const block = BLOCK.replace(`figures/${NAME}.jpg`, JPEG_DATA_URL)
    const { container } = render(<AnnotatedFigure block={block} />)
    await waitFor(() => expect(container.querySelector('.ca-mark')).toBeInTheDocument())
    expect(fetchVkFigure).not.toHaveBeenCalled()
    expect(screen.getByAltText('图3')).toHaveAttribute('src', JPEG_DATA_URL)
  })
})

describe('AnnotatedFigure 净化', () => {
  it('批注里的 script、事件属性和表单控件被去掉,标记和文字还在', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const block = BLOCK.replace(
      '投入 18 万 → 24.6 万，浮盈约 37%',
      '<script>alert(1)</script><img src="x" onerror="alert(2)"> <b onclick="alert(3)">加粗</b> **重点** <style>.ca{display:none}</style><iframe src="https://example.com"></iframe><input value="x"> 投入 18 万',
    )
    const { container } = render(<AnnotatedFigure block={block} jobId="run:r1" />)
    await waitFor(() => expect(container.querySelector('.ca-mark')).toBeInTheDocument())

    expect(container.querySelector('script, style, iframe, input, button')).not.toBeInTheDocument()
    expect(container.querySelector('[onerror], [onclick]')).not.toBeInTheDocument()
    expect(container.innerHTML).not.toMatch(/\son\w+=/i)
    expect(container.querySelectorAll('.ca-mark')).toHaveLength(2)
    expect(container.querySelector('.ca-notes li')).toHaveTextContent('投入 18 万')
    expect(container.querySelector('.ca-notes li')).toHaveTextContent('加粗')
    expect(container.querySelector('.ca-callout')).toHaveTextContent('年化 10.2%')
  })
})

describe('AnnotatedFigure 失败退回', () => {
  it('取图失败时退回 NoteFigure(用块里的 src 和 alt)', async () => {
    vi.mocked(fetchVkFigure)
      .mockRejectedValueOnce(new HostRequestError('配图读取失败', undefined, 404))
      .mockImplementation(async () => new Blob(['jpg'], { type: 'image/jpeg' }))
    const { container } = render(<AnnotatedFigure block={BLOCK} jobId="run:r1" baseUrl="http://host" />)
    expect(await screen.findByRole('button', { name: '查看大图：图3' })).toBeInTheDocument()
    expect(container.querySelector('span.vk-figure img')).toHaveAttribute('src', 'blob:figure-1')
    expect(container.querySelector('.vk-annotated')).not.toBeInTheDocument()
    expect(fetchVkFigure).toHaveBeenCalledTimes(2)
    expect(fetchVkFigure).toHaveBeenLastCalledWith('run:r1', NAME, 'http://host')
  })

  it('原图一直取不到时显示配图加载失败,不抛错', async () => {
    vi.mocked(fetchVkFigure).mockRejectedValue(new HostRequestError('配图读取失败', undefined, 404))
    render(<AnnotatedFigure block={BLOCK} jobId="run:r1" />)
    expect(await screen.findByText('配图加载失败')).toBeInTheDocument()
  })

  it('src 不是配图引用也不是 data URL 时不取图,显示配图加载失败', async () => {
    render(<AnnotatedFigure block={BLOCK.replace(`figures/${NAME}.jpg`, 'https://example.com/a.jpg')} jobId="run:r1" />)
    expect(await screen.findByText('配图加载失败')).toBeInTheDocument()
    expect(fetchVkFigure).not.toHaveBeenCalled()
  })

  it('没有任务时配图引用取不到图,显示配图加载失败', async () => {
    render(<AnnotatedFigure block={BLOCK} />)
    expect(await screen.findByText('配图加载失败')).toBeInTheDocument()
    expect(fetchVkFigure).not.toHaveBeenCalled()
  })
})

describe('AnnotatedFigure 灯箱', () => {
  it('点图打开灯箱显示原图,Esc 关闭', async () => {
    const { container } = render(<AnnotatedFigure block={BLOCK} jobId="run:r1" />)
    await waitFor(() => expect(container.querySelector('.ca-mark')).toBeInTheDocument())

    await userEvent.click(screen.getByAltText('图3'))
    const dialog = screen.getByRole('dialog', { name: '图3' })
    expect(within(dialog).getByRole('img')).toHaveAttribute('src', JPEG_DATA_URL)

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '图3' })).not.toBeInTheDocument()
  })

  it('聚焦图区后回车打开灯箱;点右侧批注文字不开', async () => {
    const { container } = render(<AnnotatedFigure block={BLOCK} jobId="run:r1" />)
    await waitFor(() => expect(container.querySelector('.ca-mark')).toBeInTheDocument())

    await userEvent.click(container.querySelector('.ca-callout')!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    container.querySelector<HTMLElement>('.ca-stage')!.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('dialog', { name: '图3' })).toBeInTheDocument()
  })
})
