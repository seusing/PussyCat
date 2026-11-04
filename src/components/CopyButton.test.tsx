import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CopyButton } from './CopyButton'

test('悬停不改变文案与状态,只有点击复制后才进入完成态', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  render(<CopyButton label="复制命令" getText={() => 'x'} testid="copy-x" />)

  const button = screen.getByTestId('copy-x')
  // 悬停只缩放图标外层,图标本身(path d)不能变——旧实现悬停就换成对勾,文案却不变,只看 aria-label 抓不住。
  // 形变按 rAF 逐帧写 d,换图标后同步读还是旧值,所以等几帧再比。
  const glyph = () => button.querySelector('svg path')?.getAttribute('d')
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150))
  const copyGlyph = glyph()
  expect(copyGlyph).toBeTruthy()
  await userEvent.hover(button)
  await settle()
  expect(glyph()).toBe(copyGlyph)
  expect(button).toHaveAttribute('aria-label', '复制命令')
  expect(button).toHaveAttribute('data-state', 'idle')
  await userEvent.unhover(button)
  expect(glyph()).toBe(copyGlyph)
  expect(button).toHaveAttribute('aria-label', '复制命令')
  expect(button).toHaveAttribute('data-state', 'idle')
})

test('复制成功时写入剪贴板并把文案切换为已复制', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  render(<CopyButton label="复制命令" getText={() => 'opencli x y'} testid="copy-x" />)

  const button = screen.getByTestId('copy-x')
  expect(button).toHaveAttribute('aria-label', '复制命令')
  expect(button).toHaveAttribute('title', '复制命令')

  await userEvent.click(button)
  expect(writeText).toHaveBeenCalledWith('opencli x y')
  await waitFor(() => {
    expect(button).toHaveAttribute('aria-label', '已复制')
    expect(button).toHaveAttribute('title', '已复制')
    expect(button).toHaveAttribute('data-state', 'ok')
  })
  expect(button).toHaveTextContent('已复制')
})

test('复制失败时显示复制失败', async () => {
  vi.stubGlobal('navigator', {})
  ;(document as Document & { execCommand?: () => boolean }).execCommand = () => false
  render(<CopyButton label="复制命令" getText={() => 'x'} testid="copy-x" />)

  const button = screen.getByTestId('copy-x')
  await userEvent.click(button)
  await waitFor(() => {
    expect(button).toHaveAttribute('aria-label', '复制失败')
    expect(button).toHaveAttribute('data-state', 'fail')
  })
})

test('1.5 秒后恢复原始文案与状态', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  render(<CopyButton label="复制命令" getText={() => 'x'} testid="copy-x" />)

  const button = screen.getByTestId('copy-x')
  await userEvent.click(button)
  await waitFor(() => expect(button).toHaveAttribute('aria-label', '已复制'))
  await waitFor(() => {
    expect(button).toHaveAttribute('aria-label', '复制命令')
    expect(button).toHaveAttribute('data-state', 'idle')
  }, { timeout: 2500 })
})
