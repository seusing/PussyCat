import userEvent from '@testing-library/user-event'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VkTaskDetailSidebar } from './VkTaskDetailSidebar'
import type { VkJobView } from '../../host/vkClient'

const BASE = 'http://127.0.0.1:17373'

function memberProgressFixture() {
  const details = new Map<string, VkJobView>([
    ['member-a', 'batch-one', 'acquire'],
    ['member-b', 'batch-one', 'chapter'],
    ['member-c', 'batch-two', 'note'],
    ['member-d', 'batch-two', 'product'],
  ].map(([jobId, batchId, stage]) => [jobId, {
    job_id: jobId, kind: 'run', status: 'done', batch_id: batchId,
    submitted_at: '2026-09-03T00:00:00Z', finished_at: '2026-09-03T00:01:00Z',
    parent_job_id: null, cache_bypass: false,
    request: { source: `https://example.com/${jobId}`, preset: 'quick-summary' },
    progress: {
      completed_stages: [stage],
      stage_metrics: [{ stage, status: 'done', elapsed_s: 2, input_tokens: 0, output_tokens: 0, cached_tokens: 0, model_calls: 0 }],
    },
  }]))
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    if (path === '/vk/v1/providers') return new Response(JSON.stringify({ channels: [], roles: {} }))
    if (path === '/vk/v1/jobs') return new Response(JSON.stringify(
      [...details.values()].map((detail) => ({ ...detail, source: detail.request?.source })),
    ))
    const detail = details.get(path.split('/').at(-1) ?? '')
    return new Response(JSON.stringify(detail ?? {}), { status: detail ? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { details, fetchMock }
}

function captureMemberPolling() {
  const polls = new Map<number, () => Promise<void>>()
  let timerId = 100_000
  vi.spyOn(window, 'setInterval').mockImplementation((callback: TimerHandler, delay?: number) => {
    const id = timerId++
    if (delay === 1500) polls.set(id, callback as () => Promise<void>)
    return id as unknown as ReturnType<typeof window.setInterval>
  })
  vi.spyOn(window, 'clearInterval').mockImplementation((id) => {
    if (typeof id === 'number') polls.delete(id)
  })
  return polls
}

function resultHistoryFixture(status: string) {
  const fixture = memberProgressFixture()
  const original = {
    ...fixture.details.get('member-a')!, job_id: 'result-original', batch_id: null,
    outputs: { note_path: 'notes/original.md' },
  }
  fixture.details.clear()
  fixture.details.set(original.job_id, original)
  fixture.details.set('result-middle', {
    ...original, job_id: 'result-middle', parent_job_id: original.job_id,
    submitted_at: '2026-09-03T00:02:00Z', outputs: { note_path: 'notes/middle.md' },
  })
  fixture.details.set('result-current', {
    ...original, job_id: 'result-current', parent_job_id: 'result-middle', status,
    submitted_at: '2026-09-03T00:04:00Z', outputs: {},
  })
  fixture.details.set('result-unrelated', {
    ...original, job_id: 'result-unrelated', batch_id: 'another-batch',
    submitted_at: '2026-09-03T00:06:00Z',
  })
  return fixture
}

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: (props: { 'aria-label'?: string; state?: string; speed?: number }) => (
    <div aria-label={props['aria-label']} data-state={props.state} data-speed={props.speed} />
  ),
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('VkTaskDetailSidebar', () => {
  it('连续三次双击生成独立提示,新提示在顶部且各自一秒后消失', async () => {
    memberProgressFixture()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
    const row = await screen.findByTestId('vk-task-detail-task-row-member-a')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const notices: HTMLElement[] = []
    for (let index = 0; index < 3; index += 1) {
      await act(async () => { fireEvent.doubleClick(row) })
      notices.unshift(screen.getAllByTestId('vk-copy-notice')[0])
      expect(screen.getAllByTestId('vk-copy-notice')).toEqual(notices)
      if (index < 2) await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    }
    expect(writeText).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(599) })
    expect(screen.getAllByTestId('vk-copy-notice')).toHaveLength(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.getAllByTestId('vk-copy-notice')).toEqual(notices.slice(0, 2))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.getAllByTestId('vk-copy-notice')).toEqual(notices.slice(0, 1))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.queryByTestId('vk-copy-notice')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vk-task-detail-notification')).not.toBeInTheDocument()
  })

  it('鼠标离开批量菜单后保留退出节点,动画结束再卸载', async () => {
    memberProgressFixture()
    const user = userEvent.setup()
    render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
    const button = await screen.findByRole('button', { name: '重新提交全部任务' })
    await user.hover(button)
    const menu = await screen.findByRole('menu')
    await user.hover(menu)
    await user.unhover(menu)
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 180)) })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(menu).toBeInTheDocument()
    fireEvent.mouseEnter(button.closest('.vk-task-batch-rerun')!)
    expect(screen.getByRole('menu')).toBe(menu)
    fireEvent.mouseLeave(button.closest('.vk-task-batch-rerun')!)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it.each([
    ['done', 'completed'], ['running', 'active'], ['cancelled', 'interrupted'], ['failed', 'failed'],
  ])('%s 任务只显示真实阶段并以 %s 标记最后阶段', async (status, lastState) => {
    const { details } = memberProgressFixture()
    const detail = details.get('member-a')!
    detail.status = status
    detail.progress = {
      completed_stages: ['acquire'], current_stage: 'chapter',
      stage_metrics: ['acquire', 'normalize', 'chapter'].map((stage) => ({
        stage, status: stage === 'chapter' ? status === 'done' ? 'ok' : 'running' : 'success',
        elapsed_s: 2, input_tokens: 0, output_tokens: 0, cached_tokens: 0, model_calls: 0,
      })),
    }
    render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
    await userEvent.click(await screen.findByTestId('vk-task-detail-task-row-member-a'))
    const steps = screen.getByRole('list', { name: '解析阶段' })
    expect(steps.tagName).toBe('OL')
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3)
    expect(steps.querySelector('[data-stage="acquire"]')).toHaveAttribute('data-stage-state', 'completed')
    expect(steps.querySelector('[data-stage="normalize"]')).toHaveAttribute('data-stage-state', 'completed')
    const last = steps.querySelector('[data-stage="chapter"]')!
    expect(last).toHaveAttribute('data-stage-state', lastState)
    expect(last.querySelector('.vk-task-detail-step-connector')).toBeNull()
    expect(steps.querySelectorAll('.vk-task-detail-step-connector')).toHaveLength(2)
    expect(steps.querySelector('[data-stage="note"]')).toBeNull()
    if (status === 'running') {
      expect(last).toHaveAttribute('aria-current', 'step')
      expect(within(steps).getByRole('progressbar', { name: '理解视频进行中' })).toBeInTheDocument()
      expect(steps.querySelectorAll('[data-stage-state="active"]')).toHaveLength(1)
    } else {
      expect(steps.querySelector('[aria-current="step"]')).toBeNull()
      expect(within(steps).queryByRole('progressbar', { name: '理解视频进行中' })).not.toBeInTheDocument()
    }
  })

  it.each(['failed', 'cancelled', 'running'])('最新尝试为 %s 时仍能打开单任务parent链的历史结果', async (status) => {
    resultHistoryFixture(status)
    const dispatched = vi.spyOn(window, 'dispatchEvent')
    render(<VkTaskDetailSidebar jobId="result-current" baseUrl={BASE} onClose={() => {}} />)
    const open = await screen.findByRole('button', { name: '查看解析结果' })
    await userEvent.click(open)
    const resultEvent = () => dispatched.mock.calls.map(([event]) => event as CustomEvent)
      .filter((event) => event.type === 'vk:open-output').at(-1)!
    expect(resultEvent().detail).toMatchObject({ jobId: 'result-current', title: '解析结果' })
    expect(resultEvent().detail.versionJobId).toBeUndefined()
    const versions = screen.getByRole('combobox', { name: '查看历史结果' })
    expect(versions.querySelector('option[value="result-unrelated"]')).toBeNull()
    await userEvent.selectOptions(versions, 'result-original')
    expect(resultEvent().detail).toEqual({ jobId: 'result-current', versionJobId: 'result-original', title: '解析结果' })
    expect(resultEvent().detail).not.toHaveProperty('outputId')
    expect(versions).toHaveValue('')
  })

  it('当前完成记录明确没有输出时剔除该版本并保留历史版本', async () => {
    resultHistoryFixture('done')
    render(<VkTaskDetailSidebar jobId="result-current" baseUrl={BASE} onClose={() => {}} />)
    const versions = await screen.findByRole('combobox', { name: '查看历史结果' })
    expect(versions.querySelector('option[value="result-current"]')).toBeNull()
    expect(versions.querySelector('option[value="result-middle"]')).not.toBeNull()
    expect(versions.querySelector('option[value="result-original"]')).not.toBeNull()
  })

  it('主按钮兼容当前输出路径,历史选择不携带当前输出路径', async () => {
    const { details } = resultHistoryFixture('done')
    details.get('result-current')!.outputs = { note_path: 'notes/current.md' }
    const dispatched = vi.spyOn(window, 'dispatchEvent')
    render(<VkTaskDetailSidebar jobId="result-current" baseUrl={BASE} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: '查看解析结果' }))
    const events = () => dispatched.mock.calls.map(([event]) => event as CustomEvent)
      .filter((event) => event.type === 'vk:open-output')
    expect(events().at(-1)!.detail).toMatchObject({ jobId: 'result-current', outputId: 'notes/current.md' })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '查看历史结果' }), 'result-original')
    expect(events().at(-1)!.detail).toEqual({ jobId: 'result-current', versionJobId: 'result-original', title: '解析结果' })
  })

  it('同来源的不同批次不能借用另一批的历史结果入口', async () => {
    const { details } = resultHistoryFixture('failed')
    const current = details.get('result-current')!
    current.parent_job_id = null
    current.batch_id = 'separate-batch'
    render(<VkTaskDetailSidebar jobId="result-current" baseUrl={BASE} onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '查看解析结果' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '查看历史结果' })).not.toBeInTheDocument()
  })

  it('切换详情加载期间不展示上一任务的结果入口', async () => {
    const { details, fetchMock } = resultHistoryFixture('failed')
    const originalFetch = fetchMock.getMockImplementation()!
    let finish: ((response: Response) => void) | undefined
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith('/result-current')) return new Promise<Response>((resolveResponse) => { finish = resolveResponse })
      return originalFetch(input)
    })
    const props = { baseUrl: BASE, onClose: () => {} }
    const { rerender } = render(<VkTaskDetailSidebar {...props} jobId="result-original" />)
    expect(await screen.findByRole('button', { name: '查看解析结果' })).toBeInTheDocument()
    rerender(<VkTaskDetailSidebar {...props} jobId="result-current" />)
    expect(screen.queryByRole('button', { name: '查看解析结果' })).not.toBeInTheDocument()
    await act(async () => { finish?.(new Response(JSON.stringify(details.get('result-current')))) })
    expect(await screen.findByRole('button', { name: '查看解析结果' })).toBeInTheDocument()
  })

  it('详情先返回时立即显示当前结果,不等待慢任务列表', async () => {
    const { details, fetchMock } = resultHistoryFixture('done')
    details.get('result-current')!.outputs = { note_path: 'notes/current.md' }
    const originalFetch = fetchMock.getMockImplementation()!
    let releaseRows!: (response: Response) => void
    const rowsPending = new Promise<Response>((resolve) => { releaseRows = resolve })
    fetchMock.mockImplementation(async (input) => {
      if (new URL(String(input)).pathname === '/vk/v1/jobs') return rowsPending
      return originalFetch(input)
    })
    const dispatched = vi.spyOn(window, 'dispatchEvent')

    render(<VkTaskDetailSidebar jobId="result-current" baseUrl={BASE} onClose={() => {}} />)
    const open = await screen.findByRole('button', { name: '查看解析结果' })
    await userEvent.click(open)
    const event = dispatched.mock.calls.map(([value]) => value as CustomEvent)
      .find((value) => value.type === 'vk:open-output')
    expect(event?.detail).toMatchObject({ jobId: 'result-current', outputId: 'notes/current.md' })

    releaseRows(new Response(JSON.stringify([...details.values()].map((detail) => ({ ...detail, source: detail.request?.source })))))
    expect(await screen.findByRole('combobox', { name: '查看历史结果' })).toBeInTheDocument()
  })

  it('同批多个成员各自展开并保留真实进度,收起一行不影响另一行', async () => {
    const { fetchMock } = memberProgressFixture()
    const onJobChange = vi.fn()
    function ControlledSidebar() {
      const [jobId, setJobId] = useState('member-a')
      return <VkTaskDetailSidebar baseUrl={BASE} onClose={() => {}} jobId={jobId} onJobChange={(next) => {
        onJobChange(next)
        setJobId(next)
      }} />
    }
    render(<ControlledSidebar />)
    const first = await screen.findByTestId('vk-task-detail-task-row-member-a')
    await userEvent.click(first)
    const second = screen.getByTestId('vk-task-detail-task-row-member-b')
    await userEvent.click(second)
    await waitFor(() => expect(within(second.closest('li')!).getByTestId('vk-task-detail-stage-details')).toHaveTextContent('理解视频'))
    expect(within(first.closest('li')!).getByTestId('vk-task-detail-stage-details')).toHaveTextContent('采集与转写')
    expect(within(first.closest('li')!).getByTestId('vk-task-detail-stage-details')).not.toHaveTextContent('理解视频')
    expect(within(second.closest('li')!).getByTestId('vk-task-detail-stage-details')).not.toHaveTextContent('采集与转写')
    expect(first).toHaveAttribute('aria-expanded', 'true')
    expect(second).toHaveAttribute('aria-expanded', 'true')
    expect(onJobChange).not.toHaveBeenCalled()
    expect(screen.queryByText('正在读取任务详情…')).not.toBeInTheDocument()
    expect(screen.getByTestId('vk-task-detail-task-row-member-a')).toBe(first)
    expect(screen.getByTestId('vk-task-detail-task-row-member-b')).toBe(second)
    const firstAfterReload = screen.getByTestId('vk-task-detail-task-row-member-a')
    await userEvent.click(firstAfterReload)
    expect(firstAfterReload).toHaveAttribute('aria-expanded', 'false')
    expect(second).toHaveAttribute('aria-expanded', 'true')
    expect(first.closest('li')!.querySelector('.vk-task-detail-task-disclosure')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getAllByTestId('vk-task-detail-stage-details')).toHaveLength(2)
    await userEvent.click(first)
    await userEvent.click(second)
    expect(first).toHaveAttribute('aria-expanded', 'true')
    expect(second).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('正在读取任务详情…')).not.toBeInTheDocument()
    expect(onJobChange).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/member-d'))).toBe(false)
  })

  it('小任务后台预读完成后首次展开和完整收起再展开都复用终态详情', async () => {
    const { fetchMock } = memberProgressFixture()
    render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
    const row = await screen.findByTestId('vk-task-detail-task-row-member-b')
    const card = within(row.closest('li')!)
    const detail = await card.findByTestId('vk-task-detail-stage-details')
    const disclosure = row.closest('li')!.querySelector('.vk-task-detail-task-disclosure')!
    expect(disclosure).toHaveAttribute('aria-hidden', 'true')
    const count = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/member-b')).length
    expect(count).toBe(1)
    await userEvent.click(row)
    expect(card.queryByText('正在读取小任务进度…')).not.toBeInTheDocument()
    expect(card.getByTestId('vk-task-detail-stage-details')).toBe(detail)
    await userEvent.click(row)
    expect(disclosure).toHaveAttribute('aria-hidden', 'true')
    await waitFor(() => expect(disclosure).toHaveStyle({ gridTemplateRows: '0fr' }))
    expect(detail).toBeInTheDocument()
    await userEvent.click(row)
    expect(disclosure).toHaveAttribute('aria-hidden', 'false')
    expect(card.getByTestId('vk-task-detail-stage-details')).toBe(detail)
    expect(card.queryByText('正在读取小任务进度…')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/member-b'))).toHaveLength(count)
  })

  it('批次轮询进入终态保持已展开成员,收起后停止该成员进度轮询', async () => {
    const polls = captureMemberPolling()
    const { details, fetchMock } = memberProgressFixture()
    details.get('member-b')!.status = 'running'
    details.get('member-b')!.progress!.current_stage = 'chapter'
    details.get('member-b')!.progress!.completed_stages = []
    details.get('member-b')!.progress!.stage_metrics![0].status = 'running'
    render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
    await userEvent.click(await screen.findByTestId('vk-task-detail-task-row-member-a'))
    const second = screen.getByTestId('vk-task-detail-task-row-member-b')
    await within(second.closest('li')!).findByTestId('vk-task-detail-stage-details')
    expect(polls.size).toBe(1)
    await userEvent.click(second)
    await waitFor(() => expect(within(second.closest('li')!).getByTestId('vk-task-detail-stage-details')).toHaveTextContent('进行中'))
    expect(polls.size).toBe(2)
    await userEvent.click(second)
    expect(polls.size).toBe(1)
    const count = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/member-b')).length
    await act(async () => { await Promise.all([...polls.values()].map((poll) => poll())) })
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/member-b'))).toHaveLength(count))
    await userEvent.click(second)
    await waitFor(() => expect(within(second.closest('li')!).getByTestId('vk-task-detail-stage-details')).toHaveTextContent('进行中'))
    details.get('member-b')!.status = 'done'
    details.get('member-b')!.progress!.completed_stages = ['chapter']
    await act(async () => { await Promise.all([...polls.values()].map((poll) => poll())) })
    expect(screen.getByTestId('vk-task-detail-sources')).toHaveTextContent('已处理 2/2')
    expect(screen.getByTestId('vk-task-detail-task-row-member-a')).toHaveAttribute('aria-expanded', 'true')
    expect(second).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByTestId('vk-task-detail-stage-details')).toHaveLength(2)
    expect(polls.size).toBe(0)
  })

  it('切换另一批次后重置展开集合,回到原批次也保持收起', async () => {
    memberProgressFixture()
    const props = { baseUrl: BASE, onClose: () => {} }
    const { rerender } = render(<VkTaskDetailSidebar {...props} jobId="member-a" />)
    await userEvent.click(await screen.findByTestId('vk-task-detail-task-row-member-a'))
    await userEvent.click(screen.getByTestId('vk-task-detail-task-row-member-b'))
    await waitFor(() => expect(screen.getAllByTestId('vk-task-detail-stage-details')).toHaveLength(2))
    rerender(<VkTaskDetailSidebar {...props} jobId="member-c" />)
    expect(await screen.findByTestId('vk-task-detail-task-row-member-c')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: '解析阶段' })).not.toBeInTheDocument()
    rerender(<VkTaskDetailSidebar {...props} jobId="member-a" />)
    expect(await screen.findByTestId('vk-task-detail-task-row-member-a')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('vk-task-detail-task-row-member-b')).toHaveAttribute('aria-expanded', 'false')
  })

  it('成员读取失败后重开可重试,收起后的迟到结果不会启动轮询', async () => {
    const polls = captureMemberPolling()
    const { details, fetchMock } = memberProgressFixture()
    const originalFetch = fetchMock.getMockImplementation()!
    let failFirst: ((response: Response) => void) | undefined
    let finish: ((response: Response) => void) | undefined
    let attempts = 0
    fetchMock.mockImplementation(async (input) => {
      if (!String(input).endsWith('/member-b')) return originalFetch(input)
      attempts += 1
      return new Promise<Response>((resolve) => {
        if (attempts === 1) failFirst = resolve
        else finish = resolve
      })
    })
    render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
    await userEvent.click(await screen.findByTestId('vk-task-detail-task-row-member-a'))
    const second = screen.getByTestId('vk-task-detail-task-row-member-b')
    await userEvent.click(second)
    await act(async () => { failFirst?.(new Response(JSON.stringify({ error: '进度暂不可用' }), { status: 503 })) })
    expect(await within(second.closest('li')!).findByRole('alert')).toHaveTextContent('读取小任务进度失败')
    expect(within(second.closest('li')!).queryByTestId('vk-task-detail-stage-details')).not.toBeInTheDocument()
    await userEvent.click(second)
    await userEvent.click(second)
    expect(within(second.closest('li')!).getByRole('status')).toHaveTextContent('正在读取小任务进度')
    expect(within(second.closest('li')!).queryByRole('alert')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/member-b'))).toHaveLength(2)
    await userEvent.click(second)
    await act(async () => { finish?.(new Response(JSON.stringify({ ...details.get('member-b'), status: 'running' }))) })
    expect(polls.size).toBe(0)
    expect(second.closest('li')!.querySelector('.vk-task-detail-task-disclosure')).toHaveAttribute('aria-hidden', 'true')
    expect(within(second.closest('li')!).getByTestId('vk-task-detail-stage-details')).toHaveTextContent('理解视频')
    expect(screen.getAllByTestId('vk-task-detail-stage-details')).toHaveLength(2)
  })

  it('批量来源列表保持 flex 且窄侧栏下允许链接让位给状态', () => {
    const css = readFileSync(resolve(import.meta.dirname, 'VkTaskDetailSidebar.css'), 'utf8')

    expect(css).toContain('.vk-task-detail-section > ol:not(.vk-task-detail-batch-list)')
    expect(css).not.toContain('.vk-task-detail-section ol {')
    expect(css).toMatch(/\.vk-task-detail-batch-list\s*\{[^}]*display:\s*flex/)
    expect(css).toMatch(/\.vk-task-detail-batch-list\s*\{[^}]*min-width:\s*0/)
    expect(css).toMatch(/\.vk-task-detail-batch-list li\s*\{[^}]*min-width:\s*0/)
    expect(css).toMatch(/\.vk-task-detail-batch-list button\s*\{[^}]*min-width:\s*0/)
    expect(css).toContain('.vk-task-detail-batch-member[data-state=')
    expect(css).toContain('data-current')
    expect(css).not.toContain('@keyframes vk-rerun-item-in')
    expect(css).toContain('max-width: calc(100vw - 24px)')
    expect(css).toContain('.vk-task-batch-rerun-option.is-done')
    expect(css).toContain('.vk-stage-metric-chip')
    expect(css).toContain('prefers-reduced-motion')
  })

  it('列表上的任务编号要出现在详情页,提交内容排在模型配置之前', async () => {
    const user = userEvent.setup()
    // 详情页原先只给 UUID,而用户在列表上认的是编号,两边对不上号。编号由列表分配、
    // 经 localStorage 索引传过来。
    localStorage.setItem(
      'opencli-app:vk-task-number-index:v1',
      JSON.stringify({ 'job-num': 69 }),
    )
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/job-num')) {
        return new Response(JSON.stringify({
          job_id: 'job-num',
          kind: 'run',
          status: 'done',
          submitted_at: '2026-08-28T12:15:21+08:00',
          finished_at: '2026-08-28T12:16:50+08:00',
          parent_job_id: null,
          cache_bypass: false,
          request: { source: 'http://xhslink.com/o/52xnYPKG36K', preset: 'quick-summary' },
          outputs: { note_path: 'note-1' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="job-num" baseUrl={BASE} onClose={() => {}} />)

    expect(await screen.findByTestId('vk-task-detail-number')).toHaveTextContent('任务 69')
    const panel = screen.getByTestId('vk-task-detail-sidebar')
    const body = panel.textContent ?? ''
    expect(body.indexOf('提交内容')).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('提交内容')).toBeLessThan(body.indexOf('模型配置'))
    expect(screen.getByTestId('vk-task-detail-metadata')).not.toHaveTextContent('执行耗时')
    expect(screen.queryByTestId('vk-task-detail-execution-elapsed')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vk-run-metrics')).not.toBeInTheDocument()
    const taskRow = await screen.findByTestId('vk-task-detail-task-row-source-0')
    expect(taskRow.closest('li')!.querySelector('.vk-task-detail-task-disclosure')).toHaveAttribute('aria-hidden', 'true')
    await user.click(taskRow)
    const stageDetails = await screen.findByTestId('vk-task-detail-stage-details')
    expect(stageDetails.querySelectorAll('.vk-task-detail-step')).toHaveLength(0)
    // 「查看解析结果」和「再次提交任务」是同一时刻的两个选择,并排放在操作区。
    const actions = panel.querySelector('.vk-task-detail-actions')
    expect(actions?.textContent).toContain('查看解析结果')
    expect(actions?.textContent).toContain('再次提交任务')
    localStorage.clear()
  })

  it('后端没串上 parent 也照样只显示原本那几条', async () => {
    // 用户的要求是"提交时几条,永远显示几条",**与后端怎么记账无关**。历史上"重跑
    // 已完成的"走的是另开一条新任务(带 batch、不带 parent),那些行按重试链串不起来,
    // 小任务列表就一次比一次长:2 条变 3 条、3 条变 4 条。提交路径已经改成 refresh,
    // 但显示不该依赖后端一定串对 —— 归并键用来源链接,那是"这一条是哪个视频"的事实。
    const rows = [
      {
        job_id: 'a', kind: 'run', status: 'interrupted',
        submitted_at: '2026-09-01T14:53:44+08:00', finished_at: null,
        parent_job_id: null, cache_bypass: false, batch_id: 'b-88',
        source: 'http://xhslink.com/o/3w78dsVlUql',
      },
      {
        job_id: 'b', kind: 'run', status: 'done',
        submitted_at: '2026-09-01T14:53:45+08:00', finished_at: null,
        parent_job_id: null, cache_bypass: false, batch_id: 'b-88',
        source: 'http://xhslink.com/o/52xnYPKG36K',
      },
      // 同一个视频的又一次尝试,**没有 parent_job_id**
      {
        job_id: 'c', kind: 'run', status: 'running',
        submitted_at: '2026-09-01T14:54:14+08:00', finished_at: null,
        parent_job_id: null, cache_bypass: false, batch_id: 'b-88',
        source: 'http://xhslink.com/o/3w78dsVlUql',
      },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/a')) {
        return new Response(JSON.stringify({
          job_id: 'a', kind: 'run', status: 'interrupted',
          submitted_at: '2026-09-01T14:53:44+08:00', finished_at: null,
          parent_job_id: null, cache_bypass: false, batch_id: 'b-88',
          request: { source: 'http://xhslink.com/o/3w78dsVlUql', preset: 'quick-summary' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/vk/v1/jobs')) {
        return new Response(JSON.stringify(rows), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="a" baseUrl={BASE} onClose={() => {}} />)

    const sources = await screen.findByTestId('vk-task-detail-sources')
    expect(sources.textContent).toContain('共 2 个视频')
    expect(sources.textContent).not.toContain('小任务3')
    // 同一个视频取最新那次的状态
    expect([...sources.querySelectorAll('.vk-task-detail-batch-status')]
      .map((node) => node.textContent)).toEqual(['进行中', '已完成'])
  })

  it('重跑不改变小任务条数 —— 提交了几条,永远显示几条', async () => {
    // 后端把每次尝试记成一条新 job(parent 指回原条、batch 不变),这是对的:审计要
    // 看得见每一次尝试。但**界面不该因此多出行**——用户提交了 2 个视频,重跑一次之后
    // 看到的仍该是 2 条,状态从「已中断」变成新的那次的状态,而不是变成 4 条。
    const rows = [
      {
        job_id: 'orig-1', kind: 'run', status: 'interrupted',
        submitted_at: '2026-09-01T08:55:45+08:00', finished_at: null,
        parent_job_id: null, cache_bypass: false, batch_id: 'b-86',
        source: 'http://xhslink.com/o/7KxpRMJTWVG',
      },
      {
        job_id: 'orig-2', kind: 'run', status: 'interrupted',
        submitted_at: '2026-09-01T08:55:46+08:00', finished_at: null,
        parent_job_id: null, cache_bypass: false, batch_id: 'b-86',
        source: 'http://xhslink.com/o/ctLgY5XELG',
      },
      {
        job_id: 'retry-1', kind: 'run', status: 'done',
        submitted_at: '2026-09-01T09:10:01+08:00', finished_at: null,
        parent_job_id: 'orig-1', cache_bypass: false, batch_id: 'b-86',
        source: 'http://xhslink.com/o/7KxpRMJTWVG',
      },
      {
        job_id: 'retry-2', kind: 'run', status: 'running',
        submitted_at: '2026-09-01T09:10:02+08:00', finished_at: null,
        parent_job_id: 'orig-2', cache_bypass: false, batch_id: 'b-86',
        source: 'http://xhslink.com/o/ctLgY5XELG',
      },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/orig-1')) {
        return new Response(JSON.stringify({
          job_id: 'orig-1', kind: 'run', status: 'interrupted',
          submitted_at: '2026-09-01T08:55:45+08:00', finished_at: null,
          parent_job_id: null, cache_bypass: false, batch_id: 'b-86',
          request: { source: 'http://xhslink.com/o/7KxpRMJTWVG', preset: 'quick-summary' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/vk/v1/jobs')) {
        return new Response(JSON.stringify(rows), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="orig-1" baseUrl={BASE} onClose={() => {}} />)

    const sources = await screen.findByTestId('vk-task-detail-sources')
    // 两条,不是四条
    expect(sources.textContent).toContain('小任务1：')
    expect(sources.textContent).toContain('小任务2：')
    expect(sources.textContent).not.toContain('小任务3')
    // 每条显示的是**最新一次尝试**的状态
    const items = sources.querySelectorAll('.vk-task-detail-batch-status')
    expect(items).toHaveLength(2)
    expect([...items].map((node) => node.textContent)).toEqual(['已完成', '进行中'])
  })

  it('小任务显示的是视频链接 —— 列表接口把 source 放在行的顶层', async () => {
    // 这条是补一次真机翻车:实现时按 `request.source` 读,而列表接口给的是**顶层**
    // `source`。类型上 VkJobRow 当时也没有这个字段,于是永远取不到、六条小任务
    // 显示的全是 UUID。测试当时用的夹具恰好写成了 request 形状,把 bug 一起放过了。
    // 现在夹具照列表接口的真实形状写。
    const listRows = [
      {
        job_id: 'm-1', kind: 'run', status: 'interrupted', submitted_at: '2026-08-31T20:19:02+08:00',
        finished_at: null, parent_job_id: null, cache_bypass: false, batch_id: 'b-9',
        source: 'http://xhslink.com/o/7KxpRMJTWVG',
      },
      {
        job_id: 'm-2', kind: 'run', status: 'interrupted', submitted_at: '2026-08-31T20:19:03+08:00',
        finished_at: null, parent_job_id: null, cache_bypass: false, batch_id: 'b-9',
        source: 'http://xhslink.com/o/ctLgY5XELG',
      },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/m-1')) {
        return new Response(JSON.stringify({
          job_id: 'm-1', kind: 'run', status: 'interrupted',
          submitted_at: '2026-08-31T20:19:02+08:00', finished_at: null,
          parent_job_id: null, cache_bypass: false, batch_id: 'b-9',
          request: { source: 'http://xhslink.com/o/7KxpRMJTWVG', preset: 'quick-summary' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/vk/v1/jobs')) {
        return new Response(JSON.stringify(listRows), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="m-1" baseUrl={BASE} onClose={() => {}} />)

    const sources = await screen.findByTestId('vk-task-detail-sources')
    expect(sources.textContent).toContain('小任务1：http://xhslink.com/o/7KxpRMJTWVG')
    expect(sources.textContent).toContain('小任务2：http://xhslink.com/o/ctLgY5XELG')
    expect(sources.textContent).not.toContain('m-1')
  })

  it('打开批内成员时,标题按批次回查编号 —— 直查 job_id 必然落空', async () => {
    // 列表把一批折成一行,只记得住那一行的 job_id;详情页打开的却往往是批里的另一个
    // 成员。只按 job_id 查索引就查不到,标题退回一串 UUID —— 真机上就是这样。
    localStorage.setItem(
      'opencli-app:vk-task-number-index:v1',
      JSON.stringify({ 'batch:b-9': 81 }),
    )
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/member-4')) {
        return new Response(JSON.stringify({
          job_id: 'member-4', kind: 'run', status: 'interrupted',
          submitted_at: '2026-08-31T20:22:54+08:00', finished_at: null,
          parent_job_id: 'm-1', cache_bypass: false, batch_id: 'b-9',
          request: { source: 'http://xhslink.com/o/3JhSoa6TiKq', preset: 'quick-summary' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/vk/v1/jobs')) {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="member-4" baseUrl={BASE} onClose={() => {}} />)

    expect(await screen.findByTestId('vk-task-detail-number')).toHaveTextContent('任务 81')
    localStorage.clear()
  })

  it('批量提交的详情页列出全部视频与各自状态,并可点进任一条', async () => {
    const user = userEvent.setup()
    const members = [
      { job_id: 'b-1', status: 'done', source: 'https://example.com/one' },
      { job_id: 'b-2', status: 'failed', source: 'https://example.com/two' },
      { job_id: 'b-3', status: 'running', source: 'https://example.com/three' },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const hit = members.find((member) => url.endsWith(`/vk/v1/jobs/${member.job_id}`))
      if (hit) {
        return new Response(JSON.stringify({
          job_id: hit.job_id,
          kind: 'run',
          status: hit.status,
          submitted_at: '2026-08-28T12:15:21+08:00',
          finished_at: null,
          parent_job_id: null,
          batch_id: 'batch-x',
          cache_bypass: false,
          request: { source: hit.source, preset: 'quick-summary' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/vk/v1/jobs')) {
        return new Response(JSON.stringify(members.map((member) => ({
          job_id: member.job_id,
          kind: 'run',
          status: member.status,
          submitted_at: '2026-08-28T12:15:21+08:00',
          finished_at: null,
          parent_job_id: null,
          batch_id: 'batch-x',
          cache_bypass: false,
          request: { source: member.source },
        }))), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }))
    const onJobChange = vi.fn()

    render(
      <VkTaskDetailSidebar jobId="b-1" baseUrl={BASE} onClose={() => {}} onJobChange={onJobChange} />,
    )

    const panel = await screen.findByTestId('vk-task-detail-sources')
    // 3 个视频里 2 个已到终态(done/failed),第 3 个还在跑
    expect(panel).toHaveTextContent('共 3 个视频 · 已处理 2/3')
    expect(panel).toHaveTextContent('https://example.com/two')
    expect(screen.getByTestId('vk-task-detail-task-row-b-3')).toBeInTheDocument()
    await user.click(screen.getByTestId('vk-task-detail-task-row-b-3'))
    expect(onJobChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('vk-task-detail-task-row-b-3')).toHaveAttribute('aria-expanded', 'true')
  })

  it('双击任务卡复制链接并显示已复制提示', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const members = [
      { job_id: 'copy-1', status: 'done', source: 'https://example.com/copy-one' },
      { job_id: 'copy-2', status: 'failed', source: 'https://example.com/copy-two' },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const hit = members.find((member) => url.endsWith(`/vk/v1/jobs/${member.job_id}`))
      if (hit) {
        return new Response(JSON.stringify({
          job_id: hit.job_id,
          kind: 'run',
          status: hit.status,
          submitted_at: '2026-08-28T12:15:21Z',
          finished_at: '2026-08-28T12:16:21Z',
          parent_job_id: null,
          batch_id: 'batch-copy',
          cache_bypass: false,
          request: { source: hit.source, preset: 'quick-summary' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/vk/v1/jobs')) {
        return new Response(JSON.stringify(members.map((member) => ({
          job_id: member.job_id,
          kind: 'run',
          status: member.status,
          submitted_at: '2026-08-28T12:15:21Z',
          finished_at: '2026-08-28T12:16:21Z',
          parent_job_id: null,
          batch_id: 'batch-copy',
          cache_bypass: false,
          request: { source: member.source },
          source: member.source,
        }))), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="copy-1" baseUrl={BASE} onClose={() => {}} />)

    const taskRow = await screen.findByTestId('vk-task-detail-task-row-copy-1')
    expect(taskRow).toHaveAttribute('title', '双击复制链接')
    await user.dblClick(taskRow)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(members[0].source))
    expect(writeText).toHaveBeenCalledTimes(1)
    const notice = await screen.findByText('已复制链接')
    expect(notice).toBeInTheDocument()
    expect(screen.getByTestId('vk-task-detail-notification')).toContainElement(notice)
  })

  it('任务卡点击后渐进展示阶段详情,没有指标时不显示未来阶段', async () => {
    const user = userEvent.setup()
    const members = [
      { job_id: 'stage-1', status: 'done', source: 'https://example.com/stage-one' },
      { job_id: 'stage-2', status: 'done', source: 'https://example.com/stage-two' },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/stage-1')) {
        return new Response(JSON.stringify({
          job_id: 'stage-1',
          kind: 'run',
          status: 'done',
          submitted_at: '2026-08-28T12:15:21Z',
          finished_at: '2026-08-28T12:16:21Z',
          parent_job_id: null,
          batch_id: 'batch-stage',
          cache_bypass: false,
          request: { source: members[0].source, preset: 'quick-summary' },
          progress: {
            completed_stages: ['acquire'],
            stage_metrics: [{
              stage: 'acquire', status: 'done', elapsed_s: 2,
              input_tokens: 0, output_tokens: 0, cached_tokens: 0, model_calls: 0,
            }],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/vk/v1/jobs/stage-2')) {
        return new Response(JSON.stringify({
          job_id: 'stage-2',
          kind: 'run',
          status: 'done',
          submitted_at: '2026-08-28T12:15:22Z',
          finished_at: '2026-08-28T12:16:22Z',
          parent_job_id: null,
          batch_id: 'batch-stage',
          cache_bypass: false,
          request: { source: members[1].source, preset: 'quick-summary' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/vk/v1/jobs')) {
        return new Response(JSON.stringify(members.map((member) => ({
          job_id: member.job_id,
          kind: 'run',
          status: member.status,
          submitted_at: '2026-08-28T12:15:21Z',
          finished_at: '2026-08-28T12:16:21Z',
          parent_job_id: null,
          batch_id: 'batch-stage',
          cache_bypass: false,
          request: { source: member.source },
          source: member.source,
        }))), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="stage-1" baseUrl={BASE} onClose={() => {}} />)

    const firstRow = await screen.findByTestId('vk-task-detail-task-row-stage-1')
    expect(firstRow.closest('li')!.querySelector('.vk-task-detail-task-disclosure')).toHaveAttribute('aria-hidden', 'true')
    await user.click(firstRow)
    const details = within(firstRow.closest('li')!).getByTestId('vk-task-detail-stage-details')
    expect(details).toHaveTextContent('采集与转写')
    expect(details).toHaveTextContent('2s')

  })

  it('没有 stage_metrics 时展开只保留进度,不显示未来阶段', async () => {
    const user = userEvent.setup()
    const source = 'https://example.com/no-stage-metrics'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/no-stage-metrics')) {
        return new Response(JSON.stringify({
          job_id: 'no-stage-metrics',
          kind: 'run',
          status: 'done',
          submitted_at: '2026-08-28T12:15:21Z',
          finished_at: '2026-08-28T12:16:21Z',
          parent_job_id: null,
          cache_bypass: false,
          request: { source, preset: 'quick-summary' },
          progress: { completed_stages: ['acquire'] },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="no-stage-metrics" baseUrl={BASE} onClose={() => {}} />)

    const row = await screen.findByTestId('vk-task-detail-task-row-source-0')
    expect(row.closest('li')!.querySelector('.vk-task-detail-task-disclosure')).toHaveAttribute('aria-hidden', 'true')
    await user.click(row)

    const details = await screen.findByTestId('vk-task-detail-stage-details')
    expect(details).toHaveAttribute('data-testid', 'vk-task-detail-stage-details')
    expect(details.querySelectorAll('.vk-task-detail-step')).toHaveLength(1)
    expect(details).toHaveTextContent('采集与转写')
    expect(details).not.toHaveTextContent('理解视频')
  })

  it('整批重跑:失败的走 retry,已完成的走 refresh,进行中的跳过', async () => {
    const user = userEvent.setup()
    const members = [
      { job_id: 'r-1', status: 'done', source: 'https://example.com/one' },
      { job_id: 'r-2', status: 'failed', source: 'https://example.com/two' },
      { job_id: 'r-3', status: 'running', source: 'https://example.com/three' },
    ]
    const retried: string[] = []
    const refreshed: string[] = []
    const resubmitted: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const retryHit = url.match(/\/vk\/v1\/jobs\/([^/]+)\/retry$/)
      if (retryHit) {
        retried.push(retryHit[1])
        return new Response(JSON.stringify({ job_id: `${retryHit[1]}-retry` }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      const refreshHit = url.match(/\/vk\/v1\/jobs\/([^/]+)\/refresh$/)
      if (refreshHit) {
        refreshed.push(refreshHit[1])
        return new Response(JSON.stringify({ job_id: `${refreshHit[1]}-refresh` }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/vk/v1/jobs') && init?.method === 'POST') {
        resubmitted.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ job_id: 'fresh-1', kind: 'run' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      const hit = members.find((member) => url.endsWith(`/vk/v1/jobs/${member.job_id}`))
      if (hit) {
        return new Response(JSON.stringify({
          job_id: hit.job_id, kind: 'run', status: hit.status,
          submitted_at: '2026-08-28T12:15:21+08:00', finished_at: null,
          parent_job_id: null, batch_id: 'batch-r', cache_bypass: false,
          request: { source: hit.source, preset: 'quick-summary' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/vk/v1/jobs')) {
        return new Response(JSON.stringify(members.map((member) => ({
          job_id: member.job_id, kind: 'run', status: member.status,
          submitted_at: '2026-08-28T12:15:21+08:00', finished_at: null,
          parent_job_id: null, batch_id: 'batch-r', cache_bypass: false,
          request: { source: member.source },
        }))), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="r-1" baseUrl={BASE} onClose={() => {}} />)

    // 默认只选失败的那条:三条里只有 r-2 失败,所以按钮说的是「重跑小任务2」
    expect(await screen.findByRole('button', { name: /重跑小任务2/ })).toBeInTheDocument()
    // 展开上拉菜单,勾上已完成的那条 —— 用户要能自己挑
    await user.click(screen.getByRole('button', { name: '展开小任务选择' }))
    const menu = await screen.findByRole('menu')
    const menuQueries = within(menu)
    const doneItem = menuQueries.getByRole('menuitemcheckbox', { name: /小任务1/ })
    expect(doneItem).toHaveAttribute('aria-checked', 'false')
    expect(doneItem).toHaveTextContent('再计费')      // 重跑已完成的会再花钱,得写明
    // 进行中的那条不能选:它本来就在跑
    expect(menuQueries.getByRole('menuitemcheckbox', { name: /小任务3/ })).toBeDisabled()
    await user.click(doneItem)

    await user.click(await screen.findByRole('button', { name: /重跑全部 2 个/ }))

    // 逐个成员串行发请求，等循环跑完再断言
    await waitFor(() => expect(retried).toEqual(['r-2']))     // 失败的走 retry
    await waitFor(() => expect(refreshed).toEqual(['r-1']))   // 已完成的走 refresh
    // **不许再走"另开一条新任务"那条路**:那样出来的 job 没有 parent,前端按重试链
    // 折叠时认不出它是同一个视频的又一次尝试,小任务列表就会一次比一次长。
    expect(resubmitted).toHaveLength(0)
  })

  it('当前成员先结束时仍轮询批次,直到最后一个成员进入终态', async () => {
    let poll: (() => Promise<void>) | undefined
    let listRequests = 0
    vi.spyOn(window, 'setInterval').mockImplementation((callback: TimerHandler, delay?: number) => {
      if (delay === 1500) poll = callback as () => Promise<void>
      return 999_998 as never
    })
    const rows = (siblingStatus: 'running' | 'done') => [
      {
        job_id: 'batch-current', kind: 'run', status: 'done',
        submitted_at: '2026-08-28T12:15:21+08:00', finished_at: '2026-08-28T12:16:21+08:00',
        parent_job_id: null, cache_bypass: false, batch_id: 'batch-live',
        source: 'https://example.com/current',
      },
      {
        job_id: 'batch-sibling', kind: 'run', status: siblingStatus,
        submitted_at: '2026-08-28T12:15:22+08:00',
        finished_at: siblingStatus === 'done' ? '2026-08-28T12:16:22+08:00' : null,
        parent_job_id: null, cache_bypass: false, batch_id: 'batch-live',
        source: 'https://example.com/sibling',
      },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/batch-current')) {
        return new Response(JSON.stringify({
          job_id: 'batch-current', kind: 'run', status: 'done',
          submitted_at: '2026-08-28T12:15:21+08:00', finished_at: '2026-08-28T12:16:21+08:00',
          parent_job_id: null, cache_bypass: false, batch_id: 'batch-live',
          request: { source: 'https://example.com/current', preset: 'quick-summary' },
        }), { status: 200 })
      }
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      if (url.endsWith('/vk/v1/jobs')) {
        listRequests += 1
        return new Response(JSON.stringify(rows(listRequests === 1 ? 'running' : 'done')), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="batch-current" baseUrl={BASE} onClose={() => {}} />)

    await waitFor(() => expect(poll).toBeTypeOf('function'))
    expect(screen.queryByRole('button', { name: '重新提交全部任务' })).not.toBeInTheDocument()
    await act(async () => { await poll?.() })
    expect(await screen.findByRole('button', { name: '重新提交全部任务' })).toBeInTheDocument()
    expect(screen.getByTestId('vk-task-detail-sources')).toHaveTextContent('已处理 2/2')
  })

  it('终态批量默认真正重跑全部成员,而不是只改按钮文案', async () => {
    const user = userEvent.setup()
    const members = [
      { job_id: 'mixed-done', status: 'done', source: 'https://example.com/done' },
      { job_id: 'mixed-failed', status: 'failed', source: 'https://example.com/failed' },
    ]
    const actions: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const action = url.match(/\/vk\/v1\/jobs\/([^/]+)\/(retry|refresh)$/)
      if (action) {
        actions.push(`${action[2]}:${action[1]}`)
        return new Response(JSON.stringify({ job_id: `${action[1]}-${action[2]}` }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      const hit = members.find((member) => url.endsWith(`/vk/v1/jobs/${member.job_id}`))
      const payload = (member: typeof members[number]) => ({
        job_id: member.job_id, kind: 'run', status: member.status,
        submitted_at: '2026-08-28T12:15:21+08:00', finished_at: '2026-08-28T12:16:21+08:00',
        parent_job_id: null, batch_id: 'batch-mixed', cache_bypass: false,
        request: { source: member.source, preset: 'quick-summary' },
      })
      if (hit) return new Response(JSON.stringify(payload(hit)), { status: 200 })
      if (url.endsWith('/vk/v1/jobs')) {
        return new Response(JSON.stringify(members.map(payload)), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="mixed-done" baseUrl={BASE} onClose={() => {}} />)

    const button = await screen.findByRole('button', { name: '重新提交全部任务' })
    await user.click(button)
    await waitFor(() => expect(actions).toEqual(['refresh:mixed-done', 'retry:mixed-failed']))
  })

  it('批量重跑菜单保持条目顺序并映射语义颜色', async () => {
    const members = Array.from({ length: 5 }, (_, index) => ({
      job_id: `stagger-${index + 1}`,
      status: index === 1 ? 'interrupted' : 'done',
      source: `https://example.com/${index + 1}`,
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const hit = members.find((member) => url.endsWith(`/vk/v1/jobs/${member.job_id}`))
      const payload = (member: typeof members[number]) => ({
        job_id: member.job_id, kind: 'run', status: member.status,
        submitted_at: '2026-08-28T12:15:21+08:00', finished_at: '2026-08-28T12:16:21+08:00',
        parent_job_id: null, batch_id: 'batch-stagger', cache_bypass: false,
        request: { source: member.source, preset: 'quick-summary' },
      })
      if (hit) return new Response(JSON.stringify(payload(hit)), { status: 200 })
      if (url.endsWith('/vk/v1/jobs')) return new Response(JSON.stringify(members.map(payload)), { status: 200 })
      return new Response('{}', { status: 404 })
    }))

    const user = userEvent.setup()
    render(<VkTaskDetailSidebar jobId="stagger-1" baseUrl={BASE} onClose={() => {}} />)
    await screen.findByRole('button', { name: '重新提交全部任务' })
    await user.click(screen.getByRole('button', { name: '展开小任务选择' }))
    const menu = await screen.findByRole('menu')
    const options = within(menu).getAllByRole('menuitemcheckbox')
    expect(options).toHaveLength(5)
    expect(options[0]).toHaveTextContent('小任务1')
    expect(options[4]).toHaveTextContent('小任务5')
    expect(options[0]).toHaveAttribute('data-color', 'success')
    expect(options[1]).toHaveAttribute('data-color', 'warning')
  })

  it('只重跑选中的那一条:没勾的不动', async () => {
    const user = userEvent.setup()
    const members = [
      { job_id: 's-1', status: 'failed', source: 'https://example.com/one' },
      { job_id: 's-2', status: 'failed', source: 'https://example.com/two' },
    ]
    const retried: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const retryHit = url.match(/\/vk\/v1\/jobs\/([^/]+)\/retry$/)
      if (retryHit) {
        retried.push(retryHit[1])
        return new Response(JSON.stringify({ job_id: `${retryHit[1]}-retry` }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      const hit = members.find((member) => url.endsWith(`/vk/v1/jobs/${member.job_id}`))
      const payload = (member: typeof members[number]) => ({
        job_id: member.job_id, kind: 'run', status: member.status,
        submitted_at: '2026-08-28T12:15:21+08:00', finished_at: null,
        parent_job_id: null, batch_id: 'batch-s', cache_bypass: false,
        request: { source: member.source, preset: 'quick-summary' },
      })
      if (hit) {
        return new Response(JSON.stringify(payload(hit)), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/vk/v1/jobs')) {
        return new Response(JSON.stringify(members.map(payload)), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="s-1" baseUrl={BASE} onClose={() => {}} />)

    // 两条都失败 → 默认全选
    const button = await screen.findByRole('button', { name: '重新提交全部任务' })
    expect(button).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '展开小任务选择' }))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: /小任务1/ }))  // 取消勾选
    await user.click(await screen.findByRole('button', { name: /重跑小任务2/ }))

    await waitFor(() => expect(retried).toEqual(['s-2']))
    expect(retried).not.toContain('s-1')
  })

  it('renders reached stage details and the configured model name', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/job-1')) {
        return new Response(JSON.stringify({
          job_id: 'job-1',
          kind: 'run',
          status: 'running',
          submitted_at: '2026-08-07T10:00:00+08:00',
          finished_at: null,
          parent_job_id: null,
          cache_bypass: false,
          run_id: 'run-1',
          cost_cny: 0,
          request: {
            source: 'https://www.youtube.com/watch?v=1\nhttps://www.bilibili.com/video/BV1',
            preset: 'quick-summary',
            provider_profile: 'channel-a',
          },
          auto_route: { route: 'text_fast', processing_depth: 'quick' },
          progress: { completed_stages: ['acquire', 'normalize'], current_stage: 'chapter' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/vk/v1/providers')) {
        return new Response(JSON.stringify({
          channels: [{ id: 'channel-a', name: '我的总结模型' }],
          roles: {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }))

    render(<VkTaskDetailSidebar jobId="job-1" baseUrl={BASE} onClose={() => {}} />)

    expect(screen.queryByRole('progressbar', { name: '处理阶段进度' })).not.toBeInTheDocument()
    expect(screen.queryByText('处理进度')).not.toBeInTheDocument()
    const taskRow = await screen.findByTestId('vk-task-detail-task-row-source-0')
    await user.click(taskRow)
    const details = await within(taskRow.closest('li')!).findByTestId('vk-task-detail-stage-details')
    expect(details).toHaveTextContent('阶段 2 / 4')
    expect(details).toHaveTextContent('理解视频重点')
    expect(screen.getByText('我的总结模型')).toBeInTheDocument()
    // 标题栏现在也显示当前这条的链接,所以第一条链接会出现两次;这里断言的是「提交内容」
    // 那一段,用容器限定范围,不然是在赌页面上只有一处提到它。
    const sources = screen.getByTestId('vk-task-detail-sources')
    expect(sources).toHaveTextContent('https://www.youtube.com/watch?v=1')
    expect(sources).toHaveTextContent('https://www.bilibili.com/video/BV1')
    expect(screen.getByRole('status')).toHaveTextContent('正在执行')
  })

  it('uses five phases when a historical quick preset actually reaches claim', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/job-legacy-claim')) return new Response(JSON.stringify({
        job_id: 'job-legacy-claim', kind: 'run', status: 'running',
        submitted_at: '2026-08-07T10:00:00Z', finished_at: null,
        parent_job_id: null, cache_bypass: false,
        request: { source: 'https://example.com/v', preset: 'quick-summary' },
        progress: {
          completed_stages: ['acquire', 'normalize', 'chapter'], current_stage: 'claim',
          model_attempts: [{ attempt_number: 1, stage: 'claim', provider_route: 'primary:default', model_requested: 'm1', model_reported: '', api_style: 'openai_responses', retry_index: 0, latency_ms: 100, status: 'ok', created_at: '2026-08-07T10:00:01Z', switch_reason: null }],
        },
      }), { status: 200 })
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="job-legacy-claim" baseUrl={BASE} onClose={() => {}} />)

    const row = await screen.findByTestId('vk-task-detail-task-row-source-0')
    await user.click(row)
    const details = await screen.findByTestId('vk-task-detail-stage-details')
    expect(details).toHaveTextContent('阶段 3 / 5')
    expect(details).toHaveTextContent('核对关键信息')
  })

  it('shows stage timing without token usage details', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/job-metrics')) return new Response(JSON.stringify({
        job_id: 'job-metrics', kind: 'run', status: 'done',
        submitted_at: '2026-08-07T10:00:00Z', finished_at: '2026-08-07T10:00:10Z',
        parent_job_id: null, cache_bypass: false,
        request: { source: 'https://example.com/v', preset: 'quick-summary' },
        progress: {
          completed_stages: ['acquire', 'normalize', 'chapter', 'note', 'product'],
          usage: { input_tokens: 1234, output_tokens: 321, cached_tokens: 100, cost_cny: null, cost_status: 'unknown' },
          stage_metrics: [
            { stage: 'acquire', status: 'done', elapsed_s: 2.5, input_tokens: 0, output_tokens: 0, cached_tokens: 0, model_calls: 0 },
            { stage: 'chapter', status: 'done', elapsed_s: 7.25, input_tokens: 1234, output_tokens: 321, cached_tokens: 100, model_calls: 1 },
            { stage: 'custom-stage', status: 'done', elapsed_s: 0.5, input_tokens: 0, output_tokens: 0, cached_tokens: 0, model_calls: 0 },
          ],
        },
      }), { status: 200 })
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="job-metrics" baseUrl={BASE} onClose={() => {}} />)

    const taskRow = await screen.findByTestId('vk-task-detail-task-row-source-0')
    expect(taskRow.closest('li')!.querySelector('.vk-task-detail-task-disclosure')).toHaveAttribute('aria-hidden', 'true')
    await user.click(taskRow)
    const stages = await screen.findByTestId('vk-task-detail-stage-details')
    expect(stages).toHaveTextContent('采集与转写')
    expect(stages).toHaveTextContent('2.5s')
    expect(stages).toHaveTextContent('理解视频')
    expect(stages).toHaveTextContent('7.25s')
    expect(stages).toHaveTextContent('custom-stage')
    expect(stages).toHaveTextContent('500ms')
    expect(stages.querySelectorAll('.vk-task-detail-step p')).toHaveLength(0)
    expect(screen.queryByTestId('vk-run-metrics')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vk-model-attempts')).not.toBeInTheDocument()
    expect(stages.querySelectorAll('.vk-task-detail-step')).toHaveLength(6)
    expect(stages.querySelectorAll('.vk-task-detail-step-content > span')).toHaveLength(6)
    expect(screen.queryByTestId('vk-task-detail-execution-elapsed')).not.toBeInTheDocument()
  })

  it('keeps configured model names without displaying model attempt records', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/job-fallback')) {
        return new Response(JSON.stringify({
          job_id: 'job-fallback', kind: 'run', status: 'done',
          submitted_at: '2026-08-07T10:00:00Z', finished_at: '2026-08-07T10:00:03Z',
          parent_job_id: null, cache_bypass: false,
          request: { source: 'https://example.com/v', preset: 'quick-summary' },
          progress: { completed_stages: ['acquire', 'normalize', 'chapter', 'note', 'product'], model_attempts: [
            { attempt_number: 1, stage: 'chapter', provider_route: 'primary:default', model_requested: 'm1', model_reported: '', api_style: 'openai_responses', retry_index: 0, latency_ms: 1200, status: 'transient_error', created_at: '2026-08-07T10:00:01Z', switch_reason: null },
            { attempt_number: 2, stage: 'chapter', provider_route: 'backup:default', model_requested: 'm2', model_reported: 'm2', api_style: 'openai_responses', retry_index: 0, latency_ms: 800, status: 'ok', created_at: '2026-08-07T10:00:02Z', switch_reason: 'previous_route_transient_error' },
          ] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/vk/v1/providers')) {
        return new Response(JSON.stringify({
          channels: [{ id: 'primary', name: '主站' }, { id: 'backup', name: '备用站' }], roles: {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="job-fallback" baseUrl={BASE} onClose={() => {}} />)

    expect(await screen.findByText('主站 → 备用站')).toBeInTheDocument()
    expect(screen.queryByTestId('vk-model-attempts')).not.toBeInTheDocument()
  })

  it('keeps failed task stages while omitting streaming telemetry and usage panels', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/job-abandoned')) return new Response(JSON.stringify({
        job_id: 'job-abandoned', kind: 'run', status: 'failed',
        submitted_at: '2026-08-07T10:00:00Z', finished_at: '2026-08-07T10:00:31Z',
        parent_job_id: null, cache_bypass: false,
        request: { source: 'https://example.com/v', preset: 'quick-summary' },
        progress: {
          completed_stages: ['acquire', 'normalize'],
          usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_cny: null, cost_status: 'pending' },
          model_attempts: [{
          attempt_number: 1, stage: 'chapter', provider_route: 'primary:default',
          model_requested: 'gpt-5.6-luna', model_reported: '', api_style: 'openai_responses',
          retry_index: 0, latency_ms: 30_500, status: 'abandoned',
          created_at: '2026-08-07T10:00:01Z', switch_reason: null,
          transport_mode: 'sse', response_headers_ms: 42, first_event_ms: 61,
          first_text_ms: 93, stream_event_count: 5, max_output_tokens: 2048,
          first_reasoning_ms: 71, last_event_type: 'response.reasoning_summary_text.delta',
          last_event_ms: 30_499, terminal_event_type: null,
          stream_event_types: '{"response.created":1,"response.reasoning_summary_text.delta":4}',
          stream_done_received: false,
          reasoning_effort: 'medium', upstream_response_id: 'resp_1',
          request_may_still_run: true,
        }] },
      }), { status: 200 })
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({
        channels: [{ id: 'primary', name: '主站' }], roles: {},
      }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="job-abandoned" baseUrl={BASE} onClose={() => {}} />)

    expect(await screen.findByText('主站')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('vk-task-detail-task-row-source-0'))
    const stages = screen.getByTestId('vk-task-detail-stage-details')
    expect(stages).toHaveTextContent('理解视频')
    expect(stages.querySelector('[data-stage="chapter"]')).toHaveAttribute('data-stage-state', 'failed')
    expect(screen.queryByTestId('vk-model-attempts')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vk-run-metrics')).not.toBeInTheDocument()
  })

  it('活跃任务在详情轮询返回终态后立即切换为失败界面', async () => {
    let jobRequest = 0
    let poll: (() => Promise<void>) | undefined
    vi.spyOn(window, 'setInterval').mockImplementation((callback: TimerHandler, delay?: number) => {
      if (delay === 1500) {
        poll = callback as () => Promise<void>
      }
      return 999_999 as never
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/job-live')) {
        jobRequest += 1
        return new Response(JSON.stringify({
          job_id: 'job-live', kind: 'run', status: jobRequest === 1 ? 'running' : 'failed',
          submitted_at: '2026-08-07T10:00:00Z', finished_at: jobRequest === 1 ? null : '2026-08-07T10:01:00Z',
          parent_job_id: null, cache_bypass: false,
          request: { source: 'https://example.com/v', preset: 'quick-summary' },
          error: jobRequest === 1 ? null : '上游处理失败',
        }), { status: 200 })
      }
      if (url.endsWith('/vk/v1/providers')) {
        return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="job-live" baseUrl={BASE} onClose={() => {}} />)
    expect(await screen.findByText('正在执行')).toBeInTheDocument()
    await waitFor(() => expect(poll).toBeTypeOf('function'))

    await act(async () => { await poll?.() })

    expect(await screen.findByRole('status')).toHaveTextContent('失败')
    expect(screen.getByText('上游处理失败')).toBeInTheDocument()
    expect(screen.queryByLabelText('任务正在执行')).not.toBeInTheDocument()
  })

  it('stops an active task and exposes no retry or resubmit action', async () => {
    const user = userEvent.setup()
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/vk/v1/jobs/active')) return new Response(JSON.stringify({
        job_id: 'active', kind: 'run', status: 'running', submitted_at: '2026-08-07T10:00:00Z', finished_at: null,
        parent_job_id: null, cache_bypass: false, request: { source: 'https://example.com/v', preset: 'quick-summary' },
        progress: { completed_links: 0, total_links: 1 },
      }), { status: 200 })
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      if (url.endsWith('/cancel')) return new Response(JSON.stringify({ job_id: 'active', status: 'cancel_requested' }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    render(<VkTaskDetailSidebar jobId="active" baseUrl={BASE} onClose={() => {}} />)
    await screen.findByRole('button', { name: '停止任务' })
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '再次提交任务' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '停止任务' }))
    await waitFor(() => expect(calls.some((call) => call.endsWith('/cancel'))).toBe(true))
  })

  it('retries a failed task by selecting the returned child execution', async () => {
    const user = userEvent.setup()
    const onJobChange = vi.fn()
    const retryEvents: Array<{ jobId?: string }> = []
    const onRetrySubmitted = (event: Event) => {
      retryEvents.push((event as CustomEvent<{ jobId?: string }>).detail)
    }
    window.addEventListener('vk:job-retry-submitted', onRetrySubmitted)
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/vk/v1/jobs/failed')) return new Response(JSON.stringify({
        job_id: 'failed', kind: 'run', status: 'failed', submitted_at: '2026-08-07T10:00:00Z', finished_at: '2026-08-07T10:01:00Z',
        parent_job_id: null, cache_bypass: false, request: { source: 'https://example.com/v', preset: 'quick-summary' },
      }), { status: 200 })
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      if (url.endsWith('/retry')) return new Response(JSON.stringify({ job_id: 'retry-child', parent_job_id: 'failed' }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    render(<VkTaskDetailSidebar jobId="failed" baseUrl={BASE} onClose={() => {}} onJobChange={onJobChange} />)
    await user.click(await screen.findByRole('button', { name: '重试' }))
    await waitFor(() => expect(onJobChange).toHaveBeenCalledWith('retry-child'))
    expect(calls.some((call) => call.endsWith('/retry'))).toBe(true)
    expect(retryEvents).toEqual([{ jobId: 'retry-child' }])
    expect(screen.queryByRole('button', { name: '强制重跑' })).not.toBeInTheDocument()
    window.removeEventListener('vk:job-retry-submitted', onRetrySubmitted)
  })

  it('does not announce a rerun when the retry request fails', async () => {
    const user = userEvent.setup()
    const onRetrySubmitted = vi.fn()
    window.addEventListener('vk:job-retry-submitted', onRetrySubmitted)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/failed-retry')) return new Response(JSON.stringify({
        job_id: 'failed-retry', kind: 'run', status: 'failed', submitted_at: '2026-08-07T10:00:00Z', finished_at: '2026-08-07T10:01:00Z',
        parent_job_id: null, cache_bypass: false, request: { source: 'https://example.com/v', preset: 'quick-summary' },
      }), { status: 200 })
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      if (url.endsWith('/retry')) return new Response(JSON.stringify({ error: 'retry failed' }), { status: 502 })
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="failed-retry" baseUrl={BASE} onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: '\u91cd\u8bd5' }))
    await screen.findByRole('alert')

    expect(onRetrySubmitted).not.toHaveBeenCalled()
    window.removeEventListener('vk:job-retry-submitted', onRetrySubmitted)
  })

  it.each(['done', 'partial'])('refreshes a %s task and preserves its result after the child fails', async (status) => {
    const user = userEvent.setup()
    const onJobChange = vi.fn()
    const dispatched = vi.spyOn(window, 'dispatchEvent')
    const original = {
      job_id: 'completed', kind: 'run', status, submitted_at: '2026-08-07T10:00:00Z', finished_at: '2026-08-07T10:01:00Z',
      parent_job_id: null, cache_bypass: false, request: { source: 'https://example.com/v', preset: 'quick-summary' },
      outputs: { note_path: 'notes/original.md' },
    }
    const child = {
      ...original, job_id: 'fresh-job', status: 'failed', parent_job_id: original.job_id,
      submitted_at: '2026-08-07T10:02:00Z', outputs: {},
    }
    const posts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') posts.push(url)
      if (url.endsWith('/vk/v1/jobs/completed')) return new Response(JSON.stringify(original))
      if (url.endsWith('/vk/v1/jobs/fresh-job')) return new Response(JSON.stringify(child))
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      if (url.endsWith('/vk/v1/jobs/completed/refresh') && init?.method === 'POST') {
        return new Response(JSON.stringify({ job_id: child.job_id, parent_job_id: original.job_id }))
      }
      if (url.endsWith('/vk/v1/jobs')) return new Response(JSON.stringify(
        [original, child].map((job) => ({ ...job, source: job.request.source })),
      ))
      return new Response('{}', { status: 404 })
    }))
    const { rerender } = render(<VkTaskDetailSidebar jobId="completed" baseUrl={BASE} onClose={() => {}} onJobChange={onJobChange} />)
    await user.click(await screen.findByRole('button', { name: '再次提交任务' }))
    await waitFor(() => expect(onJobChange).toHaveBeenCalledWith('fresh-job'))
    expect(posts).toEqual([`${BASE}/vk/v1/jobs/completed/refresh`])
    expect(dispatched.mock.calls.map(([event]) => event as CustomEvent)
      .find((event) => event.type === 'vk:job-retry-submitted')?.detail).toEqual({ jobId: child.job_id })

    rerender(<VkTaskDetailSidebar jobId={child.job_id} baseUrl={BASE} onClose={() => {}} onJobChange={onJobChange} />)
    await screen.findByRole('button', { name: '重试' })
    await user.click(await screen.findByRole('button', { name: '查看解析结果' }))
    expect(dispatched.mock.calls.map(([event]) => event as CustomEvent)
      .filter((event) => event.type === 'vk:open-output').at(-1)?.detail).toEqual({
        jobId: child.job_id, versionJobId: undefined, title: '解析结果',
      })
  })

  it.each(['cancelled', 'interrupted', 'completed_after_cancel_request'])('resubmits a %s task through retry', async (status) => {
    const onJobChange = vi.fn()
    const dispatched = vi.spyOn(window, 'dispatchEvent')
    const posts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') posts.push(url)
      if (url.endsWith('/vk/v1/jobs/stopped')) return new Response(JSON.stringify({
        job_id: 'stopped', kind: 'run', status, submitted_at: '2026-08-07T10:00:00Z',
        parent_job_id: null, cache_bypass: false, request: { source: 'https://example.com/v', preset: 'quick-summary' },
      }))
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }))
      if (url.endsWith('/vk/v1/jobs/stopped/retry')) return new Response(JSON.stringify({ job_id: 'resumed-child', parent_job_id: 'stopped' }))
      return new Response('[]')
    }))
    render(<VkTaskDetailSidebar jobId="stopped" baseUrl={BASE} onClose={() => {}} onJobChange={onJobChange} />)
    await userEvent.click(await screen.findByRole('button', { name: '再次提交任务' }))
    await waitFor(() => expect(onJobChange).toHaveBeenCalledWith('resumed-child'))
    expect(posts).toEqual([`${BASE}/vk/v1/jobs/stopped/retry`])
    expect(dispatched.mock.calls.map(([event]) => event as CustomEvent)
      .find((event) => event.type === 'vk:job-retry-submitted')?.detail).toEqual({ jobId: 'resumed-child' })
  })

  it('shows an interrupted child as rerunning', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/retry-child')) return new Response(JSON.stringify({
        job_id: 'retry-child', kind: 'run', status: 'running', submitted_at: '2026-08-07T10:02:00Z', finished_at: null,
        parent_job_id: 'interrupted', cache_bypass: false, request: { source: 'https://example.com/v', preset: 'quick-summary' },
        progress: { completed_links: 0, total_links: 1 },
      }), { status: 200 })
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    render(<VkTaskDetailSidebar jobId="retry-child" baseUrl={BASE} onClose={() => {}} />)
    expect(await screen.findByText('重跑中')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('重跑中')
    expect(screen.getByRole('button', { name: '停止任务' })).toBeInTheDocument()
  })

  it('opens the canonical result inside the app', async () => {
    const user = userEvent.setup()
    const opened: Array<{ outputId?: string; title?: string; jobId?: string }> = []
    const listener = (event: Event) => {
      opened.push((event as CustomEvent<{ outputId?: string; title?: string; jobId?: string }>).detail)
    }
    window.addEventListener('vk:open-output', listener)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/completed-output')) return new Response(JSON.stringify({
        job_id: 'completed-output', kind: 'run', status: 'done', submitted_at: '2026-08-07T10:00:00Z',
        finished_at: '2026-08-07T10:01:00Z', parent_job_id: null, cache_bypass: false,
        request: { source: 'https://example.com/v', preset: 'quick-summary' },
        outputs: { note_path: 'outputs/note.md', request_path: null, audit_path: null, product_artifacts: [] },
      }), { status: 200 })
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))

    render(<VkTaskDetailSidebar jobId="completed-output" baseUrl={BASE} onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: '查看解析结果' }))

    expect(opened).toEqual([{ outputId: 'outputs/note.md', title: '解析结果', jobId: 'completed-output' }])
    expect(screen.queryByText('quick-summary MD')).not.toBeInTheDocument()
    window.removeEventListener('vk:open-output', listener)
  })

  it('treats late completion after a cancel request as interrupted and hides outputs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/cancelled-late')) return new Response(JSON.stringify({
        job_id: 'cancelled-late', kind: 'request', status: 'completed_after_cancel_request',
        submitted_at: '2026-08-07T10:00:00Z', finished_at: '2026-08-07T10:01:00Z',
        parent_job_id: null, cache_bypass: false,
        request: { source: 'https://example.com/v', preset: 'quick-summary' },
        outputs: { note_path: 'out-note', request_path: null, audit_path: null, product_artifacts: [] },
      }), { status: 200 })
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    render(<VkTaskDetailSidebar jobId="cancelled-late" baseUrl={BASE} onClose={() => {}} />)
    expect(await screen.findByRole('status')).toHaveTextContent('已中断')
    expect(screen.getByRole('button', { name: '再次提交任务' })).toBeInTheDocument()
    expect(screen.queryByText('解析结果')).not.toBeInTheDocument()
  })
})
