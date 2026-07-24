import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CopyButton } from './CopyButton'

test('点击复制成功 → 文案短暂变「已复制」', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  render(<CopyButton label="复制命令" getText={() => 'opencli x y'} testid="copy-x" />)
  await userEvent.click(screen.getByTestId('copy-x'))
  expect(writeText).toHaveBeenCalledWith('opencli x y')
  await waitFor(() => expect(screen.getByTestId('copy-x')).toHaveTextContent('已复制'))
})

test('复制失败 → 文案「复制失败」', async () => {
  vi.stubGlobal('navigator', {})
  ;(document as Document & { execCommand?: () => boolean }).execCommand = () => false
  render(<CopyButton label="复制命令" getText={() => 'x'} testid="copy-x" />)
  await userEvent.click(screen.getByTestId('copy-x'))
  await waitFor(() => expect(screen.getByTestId('copy-x')).toHaveTextContent('复制失败'))
})

test('1.5s 后文案回弹', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  render(<CopyButton label="复制命令" getText={() => 'x'} testid="copy-x" />)
  await userEvent.click(screen.getByTestId('copy-x'))
  await waitFor(() => expect(screen.getByTestId('copy-x')).toHaveTextContent('已复制'))
  await waitFor(() => expect(screen.getByTestId('copy-x')).toHaveTextContent('复制命令'), { timeout: 2500 })
})
