import { useRef, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VkOutputViewer, type VkOutputCache, type VkOutputTab } from './VkOutputViewer'
import { fetchVkJob, fetchVkOutputText, type VkJobView } from '../../host/vkClient'
import { copyText } from '../../lib/clipboard'
import { saveTextFileAs } from '../../lib/saveTextFile'
import { loadInspirationLibrary } from '../inspiration/inspirationLibrary'

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
function ReopenHarness({ item }: { item: VkOutputTab }) {
  const cache = useRef<VkOutputCache>(new Map())
  const [open, setOpen] = useState(true)
  return <>
    <button onClick={() => setOpen(true)}>查看结果</button>
    {open && <VkOutputViewer tabs={[item]} activeTabId={item.id} onSelectTab={() => {}} baseUrl="http://host"
      cache={cache.current} onClose={() => setOpen(false)} />}
  </>
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

it('收进灵感库时只保存当前结果', async () => {
  render(<Harness />)
  await screen.findByRole('heading', { name: 'a.md' })

  await userEvent.click(screen.getByTestId('vk-output-viewer-save-library'))
  expect(loadInspirationLibrary().items).toHaveLength(1)
  expect(loadInspirationLibrary().items[0]).toMatchObject({
    title: '任务 1',
    content: '# a.md\n\n正文 a.md',
    kind: 'video',
  })
  expect(screen.getByTestId('vk-output-viewer-save-library')).toHaveAccessibleName('已收进灵感库')
})

it.each([
  { item: { id: 'job:a', jobId: 'a', label: '任务 1' }, jobRequests: 1 },
  { item: { id: 'output:a', outputId: 'a.md', label: '任务 1' }, jobRequests: 0 },
])('immediately reopens a completed $item.id result from the parent cache', async ({ item, jobRequests }) => {
  render(<ReopenHarness item={item} />)
  await screen.findByRole('heading', { name: 'a.md' })
  fireEvent.click(screen.getByTestId('vk-output-viewer-close'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '查看结果' }))
  expect(screen.getByRole('heading', { name: 'a.md' })).toBeInTheDocument()
  expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(fetchVkJob).toHaveBeenCalledTimes(jobRequests)
  expect(fetchVkOutputText).toHaveBeenCalledTimes(1)
})

it('loads changed output versions and keeps cached content separate for each host', async () => {
  const cache: VkOutputCache = new Map()
  vi.mocked(fetchVkOutputText).mockImplementation(async (id, baseUrl) => `# ${baseUrl}/${id}`)
  const viewer = (baseUrl: string, outputId: string) => <VkOutputViewer
    tabs={[{ id: 'task:one', jobId: 'one', outputId, label: '任务 1' }]} activeTabId="task:one"
    onSelectTab={() => {}} onClose={() => {}} baseUrl={baseUrl} cache={cache} />
  const { rerender } = render(viewer('http://host', 'latest.md'))
  await screen.findByRole('heading', { name: 'http://host/latest.md' })

  rerender(viewer('http://host', 'previous.md'))
  expect(screen.queryByRole('heading', { name: 'http://host/latest.md' })).not.toBeInTheDocument()
  await screen.findByRole('heading', { name: 'http://host/previous.md' })
  rerender(viewer('http://other-host', 'previous.md'))
  expect(screen.queryByRole('heading', { name: 'http://host/previous.md' })).not.toBeInTheDocument()
  await screen.findByRole('heading', { name: 'http://other-host/previous.md' })

  rerender(viewer('http://host', 'previous.md'))
  expect(screen.getByRole('heading', { name: 'http://host/previous.md' })).toBeInTheDocument()
  expect(fetchVkJob).not.toHaveBeenCalled()
  expect(fetchVkOutputText).toHaveBeenCalledTimes(3)
  expect(fetchVkOutputText).toHaveBeenNthCalledWith(1, 'latest.md', 'http://host')
  expect(fetchVkOutputText).toHaveBeenNthCalledWith(2, 'previous.md', 'http://host')
  expect(fetchVkOutputText).toHaveBeenNthCalledWith(3, 'previous.md', 'http://other-host')
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

it('prefers an explicit outputId over the job lookup and reuses its content immediately', async () => {
  const items: VkOutputTab[] = [
    { id: 'direct:one', label: '结果 1', jobId: 'job-ignored', outputId: 'shared.md' },
    { id: 'direct:two', label: '结果 2', outputId: 'shared.md' },
    { id: 'job:shared', label: '结果 3', jobId: 'shared' },
  ]
  render(<Harness items={items} />)
  await screen.findByRole('heading', { name: 'shared.md' })
  expect(fetchVkJob).not.toHaveBeenCalled()
  expect(fetchVkOutputText).toHaveBeenCalledTimes(1)

  await userEvent.click(screen.getByRole('tab', { name: '结果 2' }))
  expect(screen.getByRole('heading', { name: 'shared.md' })).toBeInTheDocument()
  expect(fetchVkJob).not.toHaveBeenCalled()
  expect(fetchVkOutputText).toHaveBeenCalledTimes(1)

  await userEvent.click(screen.getByRole('tab', { name: '结果 3' }))
  await screen.findByRole('heading', { name: 'shared.md' })
  expect(fetchVkJob).toHaveBeenCalledTimes(1)
  expect(fetchVkJob).toHaveBeenCalledWith('shared', 'http://host')
  expect(fetchVkOutputText).toHaveBeenCalledTimes(1)
})

it('falls back to the first available Markdown artifact and then to audit', async () => {
  vi.mocked(fetchVkJob).mockResolvedValueOnce({ outputs: { product_artifacts: [{ markdown: '' }, { markdown: 'product.md' }], audit_path: 'audit.md' } } as VkJobView)
    .mockResolvedValueOnce({ outputs: { audit_path: 'audit.md' } } as VkJobView)
  render(<Harness />)
  await screen.findByRole('heading', { name: 'product.md' })
  await userEvent.click(screen.getByRole('tab', { name: '任务 2' }))
  await screen.findByRole('heading', { name: 'audit.md' })
})

it.each([
  { count: 15, orientation: 'horizontal', nextKey: 'ArrowRight', previousKey: 'ArrowLeft', ignoredKey: 'ArrowDown' },
  { count: 16, orientation: 'vertical', nextKey: 'ArrowDown', previousKey: 'ArrowUp', ignoredKey: 'ArrowRight' },
])('uses $orientation tab navigation for $count results', async ({ count, orientation, nextKey, previousKey, ignoredKey }) => {
  const items = Array.from({ length: count }, (_, index) => ({ id: `output:${index}`, label: `任务 ${index + 1}`, outputId: `${index}.md` }))
  render(<Harness items={items} />)
  await screen.findByRole('heading', { name: '0.md' })
  expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', orientation)
  const first = screen.getByRole('tab', { name: '任务 1' })
  const second = screen.getByRole('tab', { name: '任务 2' })
  const last = screen.getByRole('tab', { name: `任务 ${count}` })
  first.focus()
  fireEvent.keyDown(first, { key: ignoredKey })
  expect(first).toHaveAttribute('aria-selected', 'true')
  fireEvent.keyDown(first, { key: nextKey })
  expect(second).toHaveFocus()
  expect(second).toHaveAttribute('aria-selected', 'true')
  await screen.findByRole('heading', { name: '1.md' })
  fireEvent.keyDown(second, { key: previousKey })
  expect(first).toHaveFocus()
  fireEvent.keyDown(first, { key: 'End' })
  expect(last).toHaveFocus()
  expect(last).toHaveAttribute('aria-selected', 'true')
  await screen.findByRole('heading', { name: `${count - 1}.md` })
  fireEvent.keyDown(last, { key: 'Home' })
  expect(first).toHaveFocus()
  expect(first).toHaveAttribute('aria-selected', 'true')
})

it('keeps the active result when sixteen vertical tabs become fifteen horizontal tabs', async () => {
  const items = Array.from({ length: 16 }, (_, index) => ({ id: `output:${index}`, label: `任务 ${index + 1}`, outputId: `${index}.md` }))
  const { rerender } = render(<Harness items={items} />)
  await screen.findByRole('heading', { name: '0.md' })
  await userEvent.click(screen.getByRole('tab', { name: '任务 15' }))
  await screen.findByRole('heading', { name: '14.md' })
  expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical')
  const requests = vi.mocked(fetchVkOutputText).mock.calls.length
  rerender(<Harness items={items.slice(0, 15)} />)
  expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'horizontal')
  expect(screen.getByRole('tab', { name: '任务 15' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tabpanel')).toHaveTextContent('正文 14.md')
  expect(fetchVkOutputText).toHaveBeenCalledTimes(requests)
})

function VersionHarness() {
  const [jobId, setJobId] = useState('latest')
  const versions = [
    { jobId: 'latest', attempt: 2, submittedAt: '2026-09-03T08:00:00Z', status: 'done' },
    { jobId: 'previous', attempt: 1, submittedAt: '2026-09-02T08:00:00Z', status: 'done' },
  ]
  return <VkOutputViewer tabs={[{ id: 'task:one', label: '任务 1', jobId, versions }]}
    activeTabId="task:one" onSelectTab={() => {}} onSelectVersion={(_tabId, nextJobId) => setJobId(nextJobId)}
    baseUrl="http://host" onClose={() => {}} />
}

async function chooseVersion(name: RegExp) {
  await userEvent.click(screen.getByRole('combobox', { name: '选择结果版本' }))
  await userEvent.click(screen.getByRole('option', { name }))
}

it('selects versions within one tab and caches, copies, and downloads each version independently', async () => {
  render(<VersionHarness />)
  await screen.findByRole('heading', { name: 'latest.md' })
  const version = screen.getByRole('combobox', { name: '选择结果版本' })
  expect(version).toHaveAttribute('data-value', 'latest')
  expect(version).toHaveTextContent(/第 2 次.*最新结果/)
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  await userEvent.click(screen.getByTestId('vk-output-viewer-copy'))
  expect(copyText).toHaveBeenLastCalledWith('# latest.md\n\n正文 latest.md')
  await userEvent.click(screen.getByTestId('vk-output-viewer-download'))
  expect(saveTextFileAs).toHaveBeenLastCalledWith('latest.md', '# latest.md\n\n正文 latest.md', expect.any(Object))
  const content = screen.getByRole('tabpanel')
  content.scrollTop = 150
  await chooseVersion(/第 1 次/)
  expect(content.scrollTop).toBe(0)
  await screen.findByRole('heading', { name: 'previous.md' })
  expect(screen.getByTestId('vk-output-viewer-copy')).toHaveAccessibleName('复制内容')
  await userEvent.click(screen.getByTestId('vk-output-viewer-copy'))
  expect(copyText).toHaveBeenLastCalledWith('# previous.md\n\n正文 previous.md')
  await userEvent.click(screen.getByTestId('vk-output-viewer-download'))
  expect(saveTextFileAs).toHaveBeenLastCalledWith('previous.md', '# previous.md\n\n正文 previous.md', expect.any(Object))
  content.scrollTop = 80
  await chooseVersion(/第 2 次.*最新结果/)
  expect(content.scrollTop).toBe(0)
  await screen.findByRole('heading', { name: 'latest.md' })
  await chooseVersion(/第 1 次/)
  await screen.findByRole('heading', { name: 'previous.md' })
  expect(fetchVkJob).toHaveBeenCalledTimes(2)
  expect(fetchVkOutputText).toHaveBeenCalledTimes(2)
  expect(screen.getAllByRole('tab')).toHaveLength(1)
})

it('ignores a slow old version and aborts a version download when selecting another version', async () => {
  const oldVersion = deferred<string>()
  const saving = deferred<boolean>()
  vi.mocked(fetchVkOutputText).mockImplementation((id) => id === 'previous.md' ? oldVersion.promise : Promise.resolve('# Latest'))
  render(<VersionHarness />)
  await screen.findByRole('heading', { name: 'Latest' })
  await chooseVersion(/第 1 次/)
  await waitFor(() => expect(fetchVkOutputText).toHaveBeenCalledWith('previous.md', 'http://host'))
  expect(screen.getByTestId('vk-output-viewer-copy')).toBeDisabled()
  expect(screen.queryByRole('heading', { name: 'Latest' })).not.toBeInTheDocument()
  await chooseVersion(/第 2 次.*最新结果/)
  await act(async () => { oldVersion.resolve('# Previous') })
  expect(screen.getByRole('heading', { name: 'Latest' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Previous' })).not.toBeInTheDocument()
  vi.mocked(fetchVkOutputText).mockResolvedValueOnce('# Previous')
  await chooseVersion(/第 1 次/)
  await screen.findByRole('heading', { name: 'Previous' })
  vi.mocked(saveTextFileAs).mockImplementation((_name, _content, options) => {
    options?.onProgress?.(37)
    return saving.promise
  })
  await userEvent.click(screen.getByTestId('vk-output-viewer-download'))
  const signal = vi.mocked(saveTextFileAs).mock.calls[0][2]?.signal
  expect(signal?.aborted).toBe(false)
  await chooseVersion(/第 2 次.*最新结果/)
  expect(signal?.aborted).toBe(true)
  await act(async () => { saving.reject(new Error('旧版本下载失败')) })
  expect(screen.getByRole('heading', { name: 'Latest' })).toBeInTheDocument()
  expect(screen.getByTestId('vk-output-viewer-download')).toHaveAttribute('data-state', 'idle')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
