import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VkOutputViewer, type VkOutputTab } from './VkOutputViewer'
import { fetchVkJob, fetchVkOutputText, type VkJobView } from '../../host/vkClient'
import { copyText } from '../../lib/clipboard'
import { saveTextFileAs } from '../../lib/saveTextFile'

vi.mock('../../host/vkClient', () => ({ fetchVkJob: vi.fn(), fetchVkOutputText: vi.fn() }))
vi.mock('../../lib/clipboard', () => ({ copyText: vi.fn() }))
vi.mock('../../lib/saveTextFile', () => ({ saveTextFileAs: vi.fn() }))

const tabs: VkOutputTab[] = [
  { id: 'job:a', jobId: 'a', label: '任务 1', source: 'https://example.com/a' },
  { id: 'job:b', jobId: 'b', label: '任务 2' },
]
function Harness({ items = tabs }: { items?: VkOutputTab[] }) {
  const [active, setActive] = useState<string | null>(items[0].id)
  return active && <VkOutputViewer tabs={items} activeTabId={active} onSelectTab={setActive} baseUrl="http://host" onClose={() => setActive(null)} />
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.mocked(fetchVkJob).mockReset().mockImplementation(async (id) => ({ outputs: { note_path: `${id}.md` } }) as VkJobView)
  vi.mocked(fetchVkOutputText).mockReset().mockImplementation(async (id) => `# ${id}\n\n正文 ${id}`)
  vi.mocked(copyText).mockReset().mockResolvedValue(true)
  vi.mocked(saveTextFileAs).mockReset().mockResolvedValue(true)
})

it('loads only selected tasks, caches contents, and copies and saves the selected result', async () => {
  render(<Harness />)
  await screen.findByRole('heading', { name: 'a.md' })
  expect(fetchVkJob).toHaveBeenCalledTimes(1)
  expect(fetchVkOutputText).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-modal')
  await userEvent.click(screen.getByTestId('vk-output-viewer-copy'))
  expect(copyText).toHaveBeenLastCalledWith('# a.md\n\n正文 a.md')
  expect(screen.getByTestId('vk-output-viewer-copy')).toHaveTextContent('已复制')
  await userEvent.click(screen.getByRole('tab', { name: '任务 2' }))
  await screen.findByRole('heading', { name: 'b.md' })
  expect(screen.getByTestId('vk-output-viewer-copy')).toHaveTextContent('复制内容')
  await userEvent.click(screen.getByTestId('vk-output-viewer-copy'))
  expect(copyText).toHaveBeenLastCalledWith('# b.md\n\n正文 b.md')
  await userEvent.click(screen.getByTestId('vk-output-viewer-download'))
  expect(saveTextFileAs).toHaveBeenLastCalledWith('b.md', '# b.md\n\n正文 b.md', expect.any(Object))
  await userEvent.click(screen.getByRole('tab', { name: '任务 1' }))
  await screen.findByRole('heading', { name: 'a.md' })
  await userEvent.click(screen.getByTestId('vk-output-viewer-download'))
  expect(saveTextFileAs).toHaveBeenLastCalledWith('a.md', '# a.md\n\n正文 a.md', expect.any(Object))
  expect(fetchVkJob).toHaveBeenCalledTimes(2)
  expect(fetchVkOutputText).toHaveBeenCalledTimes(2)
})

it('does not let an earlier response overwrite the active tab or revive a closed viewer', async () => {
  const slowA = deferred<string>()
  const slowB = deferred<string>()
  vi.mocked(fetchVkOutputText).mockImplementation((id) => id === 'a.md' ? slowA.promise : slowB.promise)
  render(<Harness />)
  await waitFor(() => expect(fetchVkOutputText).toHaveBeenCalledWith('a.md', 'http://host'))
  await userEvent.click(screen.getByRole('tab', { name: '任务 2' }))
  expect(screen.getByRole('tab', { name: '任务 2' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByTestId('vk-output-viewer-copy')).toBeDisabled()
  await act(async () => { slowA.resolve('# Late A') })
  expect(screen.queryByRole('heading', { name: 'Late A' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId('vk-output-viewer-close'))
  await act(async () => { slowB.resolve('# Late B') })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('shows load failure in the current tab and retries the failed request', async () => {
  vi.mocked(fetchVkOutputText).mockRejectedValueOnce(new Error('读取失败')).mockResolvedValueOnce('# 重试成功')
  render(<Harness />)
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败')
  expect(screen.getByTestId('vk-output-viewer-copy')).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByRole('heading', { name: '重试成功' })
  expect(fetchVkOutputText).toHaveBeenCalledTimes(2)
})

it('cancels downloads on tab changes and close and ignores late save and copy responses', async () => {
  const saving = deferred<boolean>()
  const copying = deferred<boolean>()
  vi.mocked(saveTextFileAs).mockImplementation((_name, _content, options) => {
    options?.onProgress?.(37)
    return saving.promise
  })
  vi.mocked(copyText).mockReturnValue(copying.promise)
  render(<Harness />)
  await screen.findByRole('heading', { name: 'a.md' })
  await userEvent.click(screen.getByTestId('vk-output-viewer-copy'))
  await userEvent.click(screen.getByTestId('vk-output-viewer-download'))
  expect(screen.getByTestId('vk-output-download-progress')).toHaveAttribute('aria-valuenow', '37')
  const firstSignal = vi.mocked(saveTextFileAs).mock.calls[0][2]?.signal
  await userEvent.click(screen.getByRole('tab', { name: '任务 2' }))
  await screen.findByRole('heading', { name: 'b.md' })
  expect(firstSignal?.aborted).toBe(true)
  await act(async () => { copying.resolve(true); saving.reject(new Error('旧下载失败')) })
  expect(screen.getByTestId('vk-output-viewer-copy')).toHaveTextContent('复制内容')
  expect(screen.getByTestId('vk-output-viewer-download')).toHaveAttribute('data-state', 'idle')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  const closingSave = deferred<boolean>()
  vi.mocked(saveTextFileAs).mockReturnValueOnce(closingSave.promise)
  await userEvent.click(screen.getByTestId('vk-output-viewer-download'))
  const secondSignal = vi.mocked(saveTextFileAs).mock.calls[1][2]?.signal
  await userEvent.click(screen.getByTestId('vk-output-viewer-close'))
  expect(secondSignal?.aborted).toBe(true)
  await act(async () => { closingSave.resolve(true) })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('supports keyboard tab navigation and Escape within the viewer', async () => {
  render(<Harness />)
  await screen.findByRole('heading', { name: 'a.md' })
  const first = screen.getByRole('tab', { name: '任务 1' })
  first.focus()
  fireEvent.keyDown(first, { key: 'ArrowRight' })
  const second = screen.getByRole('tab', { name: '任务 2' })
  expect(second).toHaveFocus()
  expect(second).toHaveAttribute('aria-selected', 'true')
  await screen.findByRole('heading', { name: 'b.md' })
  fireEvent.keyDown(second, { key: 'Home' })
  expect(first).toHaveFocus()
  fireEvent.keyDown(first, { key: 'End' })
  expect(second).toHaveFocus()
  fireEvent.keyDown(second, { key: 'ArrowLeft' })
  expect(first).toHaveFocus()
  fireEvent.keyDown(first, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('opens direct documents without fetching a job and safely renders Markdown', async () => {
  vi.mocked(fetchVkOutputText).mockResolvedValue('# Safe\n\n<script>bad()</script>\n\n[unsafe](javascript:bad())')
  render(<Harness items={[{ id: 'output:note', label: '笔记', outputId: 'note' }]} />)
  await screen.findByRole('heading', { name: 'Safe' })
  expect(fetchVkJob).not.toHaveBeenCalled()
  expect(screen.getByTestId('vk-output-viewer-content').querySelector('script')).toBeNull()
  expect(screen.getByText('unsafe')).not.toHaveAttribute('href', 'javascript:bad()')
})

it('falls back to the first available Markdown artifact and then to audit', async () => {
  vi.mocked(fetchVkJob).mockResolvedValueOnce({ outputs: { product_artifacts: [{ markdown: '' }, { markdown: 'product.md' }], audit_path: 'audit.md' } } as VkJobView)
    .mockResolvedValueOnce({ outputs: { audit_path: 'audit.md' } } as VkJobView)
  render(<Harness />)
  await screen.findByRole('heading', { name: 'product.md' })
  await userEvent.click(screen.getByRole('tab', { name: '任务 2' }))
  await screen.findByRole('heading', { name: 'audit.md' })
})
