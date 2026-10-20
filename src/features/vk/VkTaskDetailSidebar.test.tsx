import userEvent from '@testing-library/user-event'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VkTaskDetailSidebar } from './VkTaskDetailSidebar'
import type { VkJobView } from '../../host/vkClient'
import { useAppStore } from '../../store/appStore'

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
    expect(menu).toHaveClass('glass-menu-effect')
    expect(menu.parentElement).toBe(document.body)
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

  it('为长视频分段与汇总调用显示中文阶段名', async () => {
    const { details } = memberProgressFixture()
    const detail = details.get('member-a')!
    detail.status = 'running'
    detail.progress = {
      completed_stages: ['summary_map'], current_stage: 'summary_reduce',
      stage_metrics: ['summary_map', 'summary_reduce'].map((stage) => ({
        stage, status: stage === 'summary_reduce' ? 'running' : 'success',
        elapsed_s: 2, input_tokens: 10, output_tokens: 5, cached_tokens: 0, model_calls: 1,
      })),
    }
    render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
    await userEvent.click(await screen.findByTestId('vk-task-detail-task-row-member-a'))
    const steps = screen.getByRole('list', { name: '解析阶段' })
    expect(steps).toHaveTextContent('分段提取')
    expect(steps).toHaveTextContent('分层汇总')
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
    await userEvent.click(versions)
    await userEvent.click(screen.getByRole('option', { name: /第 1 次/ }))
    expect(resultEvent().detail).toEqual({ jobId: 'result-current', versionJobId: 'result-original', title: '解析结果' })
    expect(resultEvent().detail).not.toHaveProperty('outputId')
    expect(versions).toHaveValue('')
  })

  it('当前完成记录明确没有输出时剔除该版本并保留历史版本', async () => {
    resultHistoryFixture('done')
    render(<VkTaskDetailSidebar jobId="result-current" baseUrl={BASE} onClose={() => {}} />)
    const versions = await screen.findByRole('combobox', { name: '查看历史结果' })
    await userEvent.click(versions)
    const listbox = screen.getByRole('listbox')
    expect(listbox.querySelector('[data-value="result-current"]')).toBeNull()
    expect(listbox.querySelector('[data-value="result-middle"]')).not.toBeNull()
    expect(listbox.querySelector('[data-value="result-original"]')).not.toBeNull()
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
    await userEvent.click(screen.getByRole('combobox', { name: '查看历史结果' }))
    await userEvent.click(screen.getByRole('option', { name: /第 1 次/ }))
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
    expect(css).toMatch(/\.vk-task-batch-rerun-list\s*\{[^}]*overflow-y:\s*auto/)
    expect(css).toMatch(/\.vk-task-batch-rerun-option\s*\{[^}]*flex:\s*none/)
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

  describe('部分完成', () => {
    const metric = (stage: string, status: string, error?: string) => ({
      stage, status, elapsed_s: 3, input_tokens: 0, output_tokens: 0, cached_tokens: 0, model_calls: 0,
      ...(error === undefined ? {} : { error }),
    })
    const member = (
      jobId: string, status: string, stages: Array<[string, string, string?]>, batchId: string | null = 'batch-97',
    ) => ({
      job_id: jobId, kind: 'run', status, batch_id: batchId,
      submitted_at: '2026-09-03T00:00:00Z', finished_at: '2026-09-03T00:05:00Z',
      parent_job_id: null, cache_bypass: false,
      request: { source: `https://example.com/${jobId}`, preset: 'quick-summary' },
      progress: {
        completed_stages: stages.filter(([, stageStatus]) => stageStatus === 'done').map(([stage]) => stage),
        stage_metrics: stages.map(([stage, stageStatus, error]) => metric(stage, stageStatus, error)),
      },
    })
    // 与真实任务 97 同形态:两个完成、一个只有转写(理解视频阶段被引擎隔离)、一个失败。
    const task97 = () => [
      member('m97-1', 'done', [['acquire', 'done'], ['normalize', 'done'], ['chapter', 'done']]),
      member('m97-2', 'done', [['acquire', 'done'], ['normalize', 'done'], ['chapter', 'done']]),
      member('m97-3', 'partial', [['acquire', 'done'], ['normalize', 'done'], ['chapter', 'quarantined']]),
      member('m97-4', 'failed', [['acquire', 'done'], ['normalize', 'failed']]),
    ]
    const stubMembers = (members: ReturnType<typeof task97>, onAction?: (action: string) => void) => {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const action = url.match(/\/vk\/v1\/jobs\/([^/]+)\/(retry|refresh)$/)
        if (action) {
          onAction?.(`${action[2]}:${action[1]}`)
          return new Response(JSON.stringify({ job_id: `${action[1]}-${action[2]}` }), { status: 200 })
        }
        const hit = members.find((item) => url.endsWith(`/vk/v1/jobs/${item.job_id}`))
        if (hit) return new Response(JSON.stringify(hit), { status: 200 })
        if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
        if (url.endsWith('/vk/v1/jobs')) {
          return new Response(JSON.stringify(members.map((item) => ({ ...item, source: item.request.source }))), { status: 200 })
        }
        return new Response('{}', { status: 404 })
      }))
    }

    it('成员行把 partial 标成「部分完成」(琥珀色),不再是「已完成」', async () => {
      stubMembers(task97())
      render(<VkTaskDetailSidebar jobId="m97-3" baseUrl={BASE} onClose={() => {}} />)
      await screen.findByTestId('vk-task-detail-task-row-m97-3')

      const rowOf = (jobId: string) => screen.getByTestId(`vk-task-detail-task-row-${jobId}`).closest('li')!
      expect(rowOf('m97-1')).toHaveAttribute('data-state', 'done')
      expect(rowOf('m97-1')).toHaveTextContent('已完成')
      expect(rowOf('m97-3')).toHaveAttribute('data-state', 'partial')
      expect(rowOf('m97-3')).toHaveAttribute('data-color', 'warning')
      expect(rowOf('m97-3')).toHaveTextContent('部分完成')
      expect(rowOf('m97-3')).not.toHaveTextContent('已完成')
      expect(rowOf('m97-4')).toHaveAttribute('data-state', 'failed')
      expect(rowOf('m97-4')).toHaveTextContent('失败')
      expect(screen.getByTestId('vk-task-detail-sources')).toHaveTextContent('共 4 个视频 · 已处理 4/4')
    })

    it('被隔离的阶段显示失败图标与原因,其余阶段照旧;失败成员的失败阶段同样标出', async () => {
      const user = userEvent.setup()
      stubMembers(task97())
      render(<VkTaskDetailSidebar jobId="m97-3" baseUrl={BASE} onClose={() => {}} />)
      await user.click(await screen.findByTestId('vk-task-detail-task-row-m97-3'))
      await user.click(screen.getByTestId('vk-task-detail-task-row-m97-4'))

      const stepsOf = async (jobId: string) => {
        const row = screen.getByTestId(`vk-task-detail-task-row-${jobId}`).closest('li')!
        return within(await within(row).findByRole('list', { name: '解析阶段' }))
      }
      const partialSteps = await stepsOf('m97-3')
      const chapter = partialSteps.getAllByRole('listitem').find((item) => item.dataset.stage === 'chapter')!
      expect(chapter).toHaveAttribute('data-stage-state', 'failed')
      expect(within(chapter).getByLabelText('失败')).toBeInTheDocument()
      expect(chapter).toHaveTextContent('这一步没有产出可用结果')
      const acquire = partialSteps.getAllByRole('listitem').find((item) => item.dataset.stage === 'acquire')!
      expect(acquire).toHaveAttribute('data-stage-state', 'completed')
      expect(acquire).not.toHaveTextContent('这一步没有产出可用结果')

      const failedSteps = await stepsOf('m97-4')
      const normalize = failedSteps.getAllByRole('listitem').find((item) => item.dataset.stage === 'normalize')!
      expect(normalize).toHaveAttribute('data-stage-state', 'failed')
      expect(within(normalize).getByLabelText('失败')).toBeInTheDocument()
    })

    it('引擎给了阶段错误原因就显示它,没给时才用兜底文案', async () => {
      const user = userEvent.setup()
      stubMembers([member('single', 'partial', [
        ['acquire', 'done'],
        ['chapter', 'quarantined', '模型两次输出都无法解析为章节结构'],
        ['note', 'failed'],
      ], null)])
      render(<VkTaskDetailSidebar jobId="single" baseUrl={BASE} onClose={() => {}} />)
      await user.click(await screen.findByTestId('vk-task-detail-task-row-source-0'))

      const steps = within(screen.getByRole('list', { name: '解析阶段' })).getAllByRole('listitem')
      const chapter = steps.find((item) => item.dataset.stage === 'chapter')!
      expect(chapter).toHaveAttribute('data-stage-state', 'failed')
      expect(chapter).toHaveTextContent('模型两次输出都无法解析为章节结构')
      expect(chapter).not.toHaveTextContent('这一步没有产出可用结果')
      const note = steps.find((item) => item.dataset.stage === 'note')!
      expect(note).toHaveAttribute('data-stage-state', 'failed')
      expect(note).toHaveTextContent('这一步没有产出可用结果')
    })

    it('单条 partial 任务的状态徽章是「部分完成」', async () => {
      stubMembers([member('single', 'partial', [['acquire', 'done'], ['chapter', 'quarantined']], null)])
      render(<VkTaskDetailSidebar jobId="single" baseUrl={BASE} onClose={() => {}} />)

      const badge = await screen.findByRole('status')
      expect(badge).toHaveTextContent('部分完成')
      expect(badge).toHaveClass('is-partial')
      expect(screen.getByTestId('vk-task-detail-task-row-source-0')).toHaveTextContent('部分完成')
    })

    it('整批重跑时 partial 成员仍按有结果的走 refresh,并标明会再计费', async () => {
      const user = userEvent.setup()
      const actions: string[] = []
      stubMembers([task97()[2], task97()[3]], (action) => actions.push(action))
      render(<VkTaskDetailSidebar jobId="m97-3" baseUrl={BASE} onClose={() => {}} />)

      const button = await screen.findByRole('button', { name: '重新提交全部任务' })
      await user.click(screen.getByRole('button', { name: '展开小任务选择' }))
      const menu = await screen.findByRole('menu')
      const option = within(menu).getByRole('menuitemcheckbox', { name: /小任务1/ })
      expect(option).toHaveTextContent('部分完成')
      expect(option).toHaveAttribute('data-color', 'warning')
      expect(menu).toHaveTextContent('其中 1 个已有结果，重跑会再计费')
      await user.click(button)
      await waitFor(() => expect(actions).toEqual(['refresh:m97-3', 'retry:m97-4']))
    })
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
    expect(menu).not.toHaveTextContent('再计费')      // 只选了失败的那条,不会多花额度
    // 进行中的那条不能选:它本来就在跑
    expect(menuQueries.getByRole('menuitemcheckbox', { name: /小任务3/ })).toBeDisabled()
    await user.click(doneItem)
    expect(menu).toHaveTextContent('其中 1 个已有结果，重跑会再计费')  // 勾上已完成的会再花钱,得写明

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

  describe('批量重跑菜单的选项与底栏', () => {
    async function openRerunMenu(members: { job_id: string; status: string; source: string }[]) {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const hit = members.find((member) => url.endsWith(`/vk/v1/jobs/${member.job_id}`))
        const payload = (member: typeof members[number]) => ({
          job_id: member.job_id, kind: 'run', status: member.status,
          submitted_at: '2026-08-28T12:15:21+08:00', finished_at: '2026-08-28T12:16:21+08:00',
          parent_job_id: null, batch_id: 'batch-menu', cache_bypass: false,
          request: { source: member.source, preset: 'quick-summary' },
        })
        if (hit) return new Response(JSON.stringify(payload(hit)), { status: 200 })
        if (url.endsWith('/vk/v1/jobs')) return new Response(JSON.stringify(members.map(payload)), { status: 200 })
        return new Response('{}', { status: 404 })
      }))
      const user = userEvent.setup()
      render(<VkTaskDetailSidebar jobId={members[0].job_id} baseUrl={BASE} onClose={() => {}} />)
      await screen.findByRole('button', { name: '重新提交全部任务' })
      await user.click(screen.getByRole('button', { name: '展开小任务选择' }))
      return { user, menu: await screen.findByRole('menu') }
    }

    it('选项只写编号、去掉协议和 www 的链接与状态,完整链接放在 title,不再写再计费', async () => {
      const full = 'https://www.xiaohongshu.com/explore/6a9a8c3700000000110337ea'
      const { menu } = await openRerunMenu([
        { job_id: 'c-1', status: 'done', source: full },
        { job_id: 'c-2', status: 'failed', source: 'http://www.bilibili.com/video/BV1xx?p=2' },
      ])
      const options = within(menu).getAllByRole('menuitemcheckbox')

      expect(options[0]).toHaveTextContent('小任务1')
      expect(options[0]).toHaveTextContent('xiaohongshu.com/explore/6a9a8c3700000000110337ea')
      expect(options[0]).not.toHaveTextContent('https://')
      expect(options[0]).not.toHaveTextContent('www.')
      expect(options[0]).toHaveTextContent('已完成')
      expect(options[0]).toHaveAttribute('title', full)
      expect(options[1]).toHaveTextContent('bilibili.com/video/BV1xx?p=2')
      expect(options[1]).toHaveAttribute('title', 'http://www.bilibili.com/video/BV1xx?p=2')
      for (const option of options) expect(option).not.toHaveTextContent('再计费')
    })

    it('底栏提示按选中且已有结果的个数显示,只选失败项时不出现', async () => {
      const { user, menu } = await openRerunMenu([
        { job_id: 'h-1', status: 'done', source: 'https://example.com/one' },
        { job_id: 'h-2', status: 'done', source: 'https://example.com/two' },
        { job_id: 'h-3', status: 'failed', source: 'https://example.com/three' },
      ])

      // 终态批量默认全选
      expect(menu).toHaveTextContent('其中 2 个已有结果，重跑会再计费')
      await user.click(within(menu).getByRole('menuitem', { name: '只选失败的' }))
      expect(menu).not.toHaveTextContent('再计费')
      await user.click(within(menu).getByRole('menuitemcheckbox', { name: /小任务1/ }))
      expect(menu).toHaveTextContent('其中 1 个已有结果，重跑会再计费')
      expect(within(menu).getByRole('menuitem', { name: '全选' })).toBeInTheDocument()
    })
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

  describe('失败原因', () => {
    const RATE_LIMITED = 'channel-a:default HTTP 429（阶段 chapter，角色 basic，路由 channel-a:default，模型 gpt-5.6-luna，接口 /v1/responses，已尝试 2 次；同角色未配置备用通道；不会跨角色自动切换）'
    const EXPIRED_KEY = "channel-a:default HTTP 401: {'error': {'code': '401', 'message': '令牌已过期或验证不正确'}}"
    const failedJob = (over: Partial<VkJobView> = {}): VkJobView => ({
      job_id: 'job-fail', kind: 'run', status: 'failed',
      submitted_at: '2026-08-07T10:00:00Z', finished_at: '2026-08-07T10:01:00Z',
      parent_job_id: null, cache_bypass: false,
      request: { source: 'https://example.com/v', preset: 'quick-summary' },
      ...over,
    })
    const stubJob = (job: VkJobView) => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith(`/vk/v1/jobs/${job.job_id}`)) return new Response(JSON.stringify(job), { status: 200 })
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      if (url.endsWith('/vk/v1/jobs')) return new Response('[]', { status: 200 })
      return new Response('{}', { status: 404 })
    }))

    it('任务错误显示一句结论与建议,引擎原文收进「原始信息」,动作带用户去模型配置', async () => {
      const user = userEvent.setup()
      useAppStore.getState().setActiveModule('vk')
      stubJob(failedJob({ error: RATE_LIMITED }))
      render(<VkTaskDetailSidebar jobId="job-fail" baseUrl={BASE} onClose={() => {}} />)

      const note = await screen.findByTestId('vk-failure-note')
      expect(note).toHaveTextContent('模型服务限流了')
      expect(note).toHaveTextContent('稍后重试，或给这个角色配一个备用通道')
      const raw = within(note).getByText('原始信息').closest('details')!
      expect(raw).not.toHaveAttribute('open')
      expect(within(raw).getByText(RATE_LIMITED)).toBeInTheDocument()

      await user.click(within(note).getByRole('button', { name: '去模型配置' }))
      expect(useAppStore.getState().activeModule).toBe('providers')
    })

    it('失败阶段带引擎错误时同样翻成人话,没有原因的阶段仍用兜底说明', async () => {
      const user = userEvent.setup()
      const metric = (stage: string, status: string, error?: string) => ({
        stage, status, elapsed_s: 3, input_tokens: 0, output_tokens: 0, cached_tokens: 0, model_calls: 0,
        ...(error === undefined ? {} : { error }),
      })
      stubJob(failedJob({
        error: null,
        progress: {
          completed_stages: ['acquire'],
          stage_metrics: [metric('acquire', 'done'), metric('chapter', 'failed', EXPIRED_KEY), metric('note', 'failed')],
        },
      }))
      render(<VkTaskDetailSidebar jobId="job-fail" baseUrl={BASE} onClose={() => {}} />)
      await user.click(await screen.findByTestId('vk-task-detail-task-row-source-0'))

      const steps = within(screen.getByRole('list', { name: '解析阶段' })).getAllByRole('listitem')
      const chapter = steps.find((item) => item.dataset.stage === 'chapter')!
      expect(chapter).toHaveTextContent('模型服务的 API key 无效或已过期')
      expect(within(chapter).getByRole('button', { name: '去模型配置' })).toBeInTheDocument()
      expect(within(chapter).getByText(EXPIRED_KEY)).toBeInTheDocument()
      const note = steps.find((item) => item.dataset.stage === 'note')!
      expect(note).toHaveTextContent('这一步没有产出可用结果')
      expect(within(note).queryByTestId('vk-failure-note')).not.toBeInTheDocument()
    })

    describe('阶段', () => {
      const metric = (stage: string, status: string, error?: string) => ({
        stage, status, elapsed_s: 3, input_tokens: 0, output_tokens: 0, cached_tokens: 0, model_calls: 0,
        ...(error === undefined ? {} : { error }),
      })
      const openSteps = async (job: VkJobView) => {
        stubJob(job)
        render(<VkTaskDetailSidebar jobId="job-fail" baseUrl={BASE} onClose={() => {}} />)
        await userEvent.setup().click(await screen.findByTestId('vk-task-detail-task-row-source-0'))
        return within(screen.getByRole('list', { name: '解析阶段' })).getAllByRole('listitem')
      }

      it('配图阶段显示为「配图」,排在整理知识笔记之前,跳过原因照常显示', async () => {
        const steps = await openSteps(failedJob({
          status: 'done',
          progress: {
            completed_stages: ['acquire', 'normalize', 'chapter', 'note'],
            stage_metrics: [
              metric('acquire', 'done'), metric('normalize', 'done'), metric('chapter', 'done'),
              metric('note', 'done'), metric('illustrate', 'skipped', '没有需要看画面的关键点'),
            ],
          },
        }))

        expect(steps.map((item) => item.dataset.stage)).toEqual(['acquire', 'normalize', 'chapter', 'illustrate', 'note'])
        const illustrate = steps.find((item) => item.dataset.stage === 'illustrate')!
        expect(illustrate).toHaveTextContent('配图')
        expect(illustrate).toHaveAttribute('data-stage-state', 'skipped')
        expect(illustrate).toHaveTextContent('已跳过：没有需要看画面的关键点')
      })

      it('同名阶段有失败时,在「其中 N 次失败」后补上第一条失败的原因,原文放进 title', async () => {
        const raw = 'storyline_reduce 两次输出均不可用：缺少 episodes'
        const steps = await openSteps(failedJob({
          status: 'done',
          progress: {
            completed_stages: ['storyline_reduce'],
            stage_metrics: [
              metric('storyline_reduce', 'done'), metric('storyline_reduce', 'failed', raw), metric('storyline_reduce', 'done'),
            ],
          },
        }))

        const reduce = steps.find((item) => item.dataset.stage === 'storyline_reduce')!
        expect(reduce).toHaveTextContent('其中 1 次失败')
        const reason = within(reduce).getByText('模型两次都没有按格式返回，这条故事线只保留了各集摘要，可以点「串联分析」重新生成')
        expect(reason).toHaveAttribute('title', raw)
        expect(within(reduce).queryByTestId('vk-failure-note')).not.toBeInTheDocument()
      })

      it('同名阶段的失败原文不在映射里时,走通用失败说明', async () => {
        const steps = await openSteps(failedJob({
          status: 'done',
          progress: {
            completed_stages: ['series_digest'],
            stage_metrics: [metric('series_digest', 'done'), metric('series_digest', 'failed', RATE_LIMITED), metric('series_digest', 'done')],
          },
        }))

        const digest = steps.find((item) => item.dataset.stage === 'series_digest')!
        expect(digest).toHaveTextContent('其中 1 次失败')
        expect(within(digest).getByTestId('vk-failure-note')).toHaveTextContent('模型服务限流了')
      })

      it('最后一次尝试失败的阶段同样走映射,原文放进 title,不再叠一个通用失败说明', async () => {
        const raw = 'storyline_reduce 两次输出均不可用：缺少 episodes'
        const steps = await openSteps(failedJob({
          progress: {
            completed_stages: [],
            stage_metrics: [metric('storyline_reduce', 'done'), metric('storyline_reduce', 'done'), metric('storyline_reduce', 'failed', raw)],
          },
        }))

        const reduce = steps.find((item) => item.dataset.stage === 'storyline_reduce')!
        expect(reduce).toHaveAttribute('data-stage-state', 'failed')
        const reason = within(reduce).getByText('模型两次都没有按格式返回，这条故事线只保留了各集摘要，可以点「串联分析」重新生成')
        expect(reason).toHaveAttribute('title', raw)
        expect(reduce).toHaveTextContent('其中 1 次失败')
        expect(within(reduce).queryByTestId('vk-failure-note')).not.toBeInTheDocument()
      })

      it('最后一次失败认不出时走通用失败说明,第一次失败的原因另行附在「其中 N 次失败」后', async () => {
        const raw = 'storyline_reduce 两次输出均不可用：缺少 episodes'
        const steps = await openSteps(failedJob({
          progress: {
            completed_stages: [],
            stage_metrics: [metric('storyline_reduce', 'failed', raw), metric('storyline_reduce', 'done'), metric('storyline_reduce', 'failed', RATE_LIMITED)],
          },
        }))

        const reduce = steps.find((item) => item.dataset.stage === 'storyline_reduce')!
        expect(reduce).toHaveTextContent('其中 2 次失败')
        expect(within(reduce).getByTestId('vk-failure-note')).toHaveTextContent('模型服务限流了')
        expect(within(reduce).getByText('模型两次都没有按格式返回，这条故事线只保留了各集摘要，可以点「串联分析」重新生成')).toHaveAttribute('title', raw)
      })
    })
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

  // 阶段审计用的夹具:阶段指标、大模型调用与 Jev 调用(接口风格 typesafe_systemone)。
  const stageMetric = (stage: string, status: string, elapsed: number | null, error?: string) => ({
    stage, status, elapsed_s: elapsed, input_tokens: 0, output_tokens: 0, cached_tokens: 0, model_calls: 0,
    ...(error === undefined ? {} : { error }),
  })
  const modelAttempt = (stage: string, over: Record<string, unknown> = {}) => ({
    attempt_number: 1, stage, provider_route: 'primary:default', model_requested: 'gpt-6-sol',
    model_reported: 'gpt-6-sol', api_style: 'openai_responses', retry_index: 0, latency_ms: 800,
    status: 'ok', created_at: '2026-09-18T00:00:01Z', switch_reason: null, ...over,
  })
  const jevAttempt = (stage: string, over: Record<string, unknown> = {}) => modelAttempt(stage, {
    provider_route: 'typesafe:jev-latest', model_requested: 'jev-latest', model_reported: 'jev-1.13.0',
    api_style: 'typesafe_systemone', ...over,
  })

  describe('串联分析区块', () => {
    const storyline = (over: Record<string, unknown> = {}) => ({
      storyline_id: 'sl_1', batch_id: 'batch-one', status: 'done', trigger: 'auto',
      requested_at: '2026-09-03T00:02:00Z', started_at: null, finished_at: null,
      error: null, reason: null, storyline_count: 2, standalone_count: 1, cost_cny: null,
      ...over,
    })

    /** 在批量夹具上叠一层 /vk/v1/storylines;rows 为 null 表示旧引擎(404)。 */
    function withStorylines(rows: Record<string, unknown>[] | null) {
      const { details, fetchMock } = memberProgressFixture()
      const state = { rows, posts: [] as unknown[], lists: 0 }
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        if (!url.pathname.startsWith('/vk/v1/storylines')) return fetchMock(input)
        if (init?.method === 'POST') {
          state.posts.push(JSON.parse(String(init.body)))
          state.rows = [storyline({ status: 'queued', trigger: 'manual' })]
          return new Response(JSON.stringify({ storyline_id: 'sl_1', status: 'queued' }), { status: 201 })
        }
        state.lists += 1
        if (!state.rows) return new Response('{}', { status: 404 })
        return new Response(JSON.stringify(state.rows.filter(() => url.searchParams.get('batch_id') === 'batch-one')))
      }))
      return { details, state }
    }

    it('批量任务显示串联状态,点「串联分析」发起并刷新状态', async () => {
      const { state } = withStorylines([])
      render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
      const section = await screen.findByTestId('vk-storyline-section')
      expect(within(section).queryByTestId('vk-storyline-status')).not.toBeInTheDocument()
      await userEvent.click(within(section).getByRole('button', { name: '串联分析' }))
      await waitFor(() => expect(within(section).getByTestId('vk-storyline-status')).toHaveTextContent('排队中'))
      expect(state.posts).toEqual([{ batch_id: 'batch-one' }])
      expect(within(section).getByRole('button', { name: '串联分析' })).toBeDisabled()
    })

    it('已完成的串联显示结论并能打开故事线结果窗口', async () => {
      withStorylines([storyline()])
      const opened: unknown[] = []
      const listener = (event: Event) => { opened.push((event as CustomEvent).detail) }
      window.addEventListener('vk:open-output', listener)
      render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
      const section = await screen.findByTestId('vk-storyline-section')
      await waitFor(() => expect(within(section).getByTestId('vk-storyline-status'))
        .toHaveTextContent('已串成 2 条故事线，1 个视频未归入'))
      expect(within(section).getByRole('button', { name: '串联分析' })).toBeEnabled()
      await userEvent.click(within(section).getByRole('button', { name: '查看故事线' }))
      expect(opened).toEqual([{ jobId: 'member-a', title: '解析结果', storyline: true }])
      window.removeEventListener('vk:open-output', listener)
    })

    it('本批解析成功的视频不足 2 个时不能发起,并说明原因', async () => {
      const { details } = withStorylines([])
      details.set('member-b', { ...details.get('member-b')!, status: 'failed' })
      render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
      const button = await within(await screen.findByTestId('vk-storyline-section')).findByRole('button', { name: '串联分析' })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('title', '至少需要 2 个解析成功的视频')
    })

    it('旧版引擎(404)时整个区块不显示', async () => {
      const { state } = withStorylines(null)
      render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
      await screen.findByTestId('vk-task-detail-task-row-member-b')
      await waitFor(() => expect(state.lists).toBe(1))
      await act(async () => {})
      expect(screen.queryByTestId('vk-storyline-section')).not.toBeInTheDocument()
      expect(screen.queryByText('串联分析')).not.toBeInTheDocument()
    })

    it('单个视频的任务不显示区块,也不请求串联记录', async () => {
      const { details, fetchMock } = memberProgressFixture()
      const solo = { ...details.get('member-a')!, job_id: 'solo', batch_id: null }
      details.clear()
      details.set('solo', solo)
      const storylineRequests: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname
        if (path.startsWith('/vk/v1/storylines')) storylineRequests.push(path)
        return fetchMock(input)
      }))
      render(<VkTaskDetailSidebar jobId="solo" baseUrl={BASE} onClose={() => {}} />)
      await screen.findByTestId('vk-task-detail-task-row-source-0')
      await act(async () => {})
      expect(screen.queryByTestId('vk-storyline-section')).not.toBeInTheDocument()
      expect(storylineRequests).toEqual([])
    })

    /** 在 withStorylines 之上再叠一层 /vk/v1/jobs/run:<id>,返回串联运行的进度视图。 */
    function withStorylineRun(rows: Record<string, unknown>[], runView: () => Record<string, unknown>) {
      const base = withStorylines(rows)
      const inner = globalThis.fetch
      const runRequests: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.pathname.startsWith('/vk/v1/jobs/run:')) {
          runRequests.push(url.pathname)
          return new Response(JSON.stringify(runView()))
        }
        return inner(input, init)
      }))
      return { ...base, runRequests }
    }

    const storylineRun = (status: string, progress: Record<string, unknown>) => ({
      job_id: 'run:run-9', kind: 'storyline', status,
      submitted_at: '2026-09-18T00:02:00Z', finished_at: status === 'running' ? null : '2026-09-18T00:03:00Z',
      parent_job_id: null, cache_bypass: false, progress,
    })
    const finishedStorylineRun = () => storylineRun('done', {
      completed_stages: ['storyline_relate', 'series_digest', 'storyline_link', 'storyline_reduce', 'storyline_compare'],
      stage_metrics: [
        stageMetric('storyline_relate', 'done', 1.2),
        stageMetric('series_digest', 'done', 2),
        stageMetric('series_digest', 'done', 3),
        stageMetric('series_digest', 'done', 1.5),
        stageMetric('series_digest', 'done', 2.5),
        stageMetric('storyline_link', 'done', 4),
        stageMetric('storyline_reduce', 'done', 5),
        stageMetric('storyline_compare', 'done', 6),
      ],
      model_attempts: [
        jevAttempt('storyline_relate'),
        ...[1, 2, 3, 4].map(() => modelAttempt('series_digest')),
        modelAttempt('storyline_link'),
        modelAttempt('storyline_reduce'),
        modelAttempt('storyline_compare'),
      ],
    })

    it('「串联过程」默认收起且不发请求,展开后按顺序列出 5 步,串联摘要合并成一行', async () => {
      const { runRequests } = withStorylineRun([storyline({ run_id: 'run-9' })], finishedStorylineRun)
      render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
      const section = await screen.findByTestId('vk-storyline-section')
      const toggle = await within(section).findByRole('button', { name: '串联过程' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await act(async () => {})
      expect(runRequests).toEqual([])
      expect(screen.queryByTestId('vk-storyline-run')).not.toBeInTheDocument()

      await userEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const region = await screen.findByTestId('vk-storyline-run')
      const steps = await within(region).findByRole('list', { name: '解析阶段' })
      expect(runRequests).toEqual(['/vk/v1/jobs/run:run-9'])
      const items = [...steps.querySelectorAll<HTMLElement>('li.vk-task-detail-step')]
      expect(items.map((item) => item.dataset.stage)).toEqual([
        'storyline_relate', 'series_digest', 'storyline_link', 'storyline_reduce', 'storyline_compare',
      ])
      expect(items[0]).toHaveTextContent('Jev 判断关联 · jev-1.13.0')
      expect(items[1].querySelector('strong')).toHaveTextContent('串联摘要 ×4 · gpt-6-sol')
      expect(items[1].querySelector('.vk-task-detail-step-content > span')).toHaveTextContent('9s')
      expect(items[2]).toHaveTextContent('关系判定')
      expect(items[3]).toHaveTextContent('故事线汇总')
      expect(items[4]).toHaveTextContent('观点对比')
      items.forEach((item) => expect(item).toHaveAttribute('data-stage-state', 'completed'))
      expect(region).toHaveTextContent('串联完成')
      expect(region).toHaveTextContent('5 个阶段已记录')

      await userEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByTestId('vk-storyline-run')).not.toBeInTheDocument()
    })

    it('串联摘要还有一次在跑、或它就是当前阶段时不算完成,运行中每 1.5 秒轮询一次', async () => {
      const polls = captureMemberPolling()
      const digests = (statuses: string[]) => statuses.map((status, index) => stageMetric('series_digest', status, index + 1))
      let run = storylineRun('running', {
        completed_stages: ['storyline_relate', 'series_digest'], current_stage: 'series_digest',
        stage_metrics: [stageMetric('storyline_relate', 'done', 1), ...digests(['done', 'done', 'running'])],
        model_attempts: [jevAttempt('storyline_relate'), modelAttempt('series_digest')],
      })
      const { runRequests } = withStorylineRun([storyline({ status: 'running', run_id: 'run-9' })], () => run)
      render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
      const section = await screen.findByTestId('vk-storyline-section')
      await userEvent.click(await within(section).findByRole('button', { name: '串联过程' }))
      const region = await screen.findByTestId('vk-storyline-run')
      await within(region).findByRole('list', { name: '解析阶段' })
      const digest = () => region.querySelector<HTMLElement>('[data-stage="series_digest"]')!
      expect(digest()).toHaveAttribute('data-stage-state', 'active')
      expect(digest().querySelector('strong')).toHaveTextContent('串联摘要 ×3')
      expect(within(digest()).queryByLabelText('已完成')).not.toBeInTheDocument()
      expect(region).toHaveTextContent('阶段 2 / 5')
      expect(polls.size).toBe(1)

      // 当前阶段已经不是它,但还有一次在跑:仍然不算完成。
      run = { ...run, progress: { ...(run.progress as object), current_stage: undefined } }
      let before = runRequests.length
      await act(async () => {
        await [...polls.values()][0]()
        await new Promise((resolve) => window.setTimeout(resolve, 20))
      })
      expect(runRequests.length).toBe(before + 1)
      expect(digest()).toHaveAttribute('data-stage-state', 'active')
      expect(region).toHaveTextContent('阶段 2 / 5')

      // 最后一次也跑完:整行完成,进度推进。
      run = {
        ...run,
        progress: {
          ...(run.progress as object),
          stage_metrics: [stageMetric('storyline_relate', 'done', 1), ...digests(['done', 'done', 'done'])],
        },
      }
      before = runRequests.length
      await act(async () => {
        await [...polls.values()][0]()
        await new Promise((resolve) => window.setTimeout(resolve, 20))
      })
      expect(runRequests.length).toBe(before + 1)
      await waitFor(() => expect(digest()).toHaveAttribute('data-stage-state', 'completed'))
      expect(digest().querySelector('.vk-task-detail-step-content > span')).toHaveTextContent('6s')
      expect(region).toHaveTextContent('阶段 3 / 5')
    })

    it.each([
      ['还没有 run_id(排队中)', { status: 'queued', run_id: null }],
      ['旧版引擎没有 run_id 这个键', {}],
    ])('%s:不出现「串联过程」', async (_name, over) => {
      const { runRequests } = withStorylineRun([storyline(over)], finishedStorylineRun)
      render(<VkTaskDetailSidebar jobId="member-a" baseUrl={BASE} onClose={() => {}} />)
      const section = await screen.findByTestId('vk-storyline-section')
      await within(section).findByTestId('vk-storyline-status')
      expect(within(section).queryByRole('button', { name: '串联过程' })).not.toBeInTheDocument()
      expect(runRequests).toEqual([])
    })
  })

  describe('Jev 筛选术语与每步模型', () => {
    const jevJob = (progress: Record<string, unknown>, status = 'done'): VkJobView => ({
      job_id: 'job-jev', kind: 'run', status,
      submitted_at: '2026-09-18T00:00:00Z', finished_at: status === 'running' ? null : '2026-09-18T00:01:00Z',
      parent_job_id: null, cache_bypass: false,
      request: { source: 'https://example.com/v', preset: 'quick-summary' },
      progress,
    })
    async function openJevJob(job: VkJobView) {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/vk/v1/jobs/job-jev')) return new Response(JSON.stringify(job), { status: 200 })
        if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({
          channels: [{ id: 'primary', name: '主站' }], roles: {},
        }), { status: 200 })
        if (url.endsWith('/vk/v1/jobs')) return new Response('[]', { status: 200 })
        return new Response('{}', { status: 404 })
      }))
      render(<VkTaskDetailSidebar jobId="job-jev" baseUrl={BASE} onClose={() => {}} />)
      await userEvent.click(await screen.findByTestId('vk-task-detail-task-row-source-0'))
      const steps = await screen.findByRole('list', { name: '解析阶段' })
      return {
        details: screen.getByTestId('vk-task-detail-stage-details'),
        steps,
        step: (stage: string) => steps.querySelector<HTMLElement>(`[data-stage="${stage}"]`)!,
      }
    }

    it('快速摘要在「理解视频」后多一行「Jev 筛选术语」,每步标注答题的模型,仍是 4 段', async () => {
      const { details, steps, step } = await openJevJob(jevJob({
        completed_stages: ['acquire', 'normalize', 'chapter', 'jev_terms'], current_stage: 'note',
        stage_metrics: [
          stageMetric('acquire', 'done', 2), stageMetric('normalize', 'done', 1),
          stageMetric('chapter', 'done', 8), stageMetric('jev_terms', 'done', 0.6),
          stageMetric('note', 'running', null),
        ],
        model_attempts: [modelAttempt('chapter'), jevAttempt('jev_terms')],
      }, 'running'))

      expect([...steps.querySelectorAll<HTMLElement>('li.vk-task-detail-step')].map((item) => item.dataset.stage))
        .toEqual(['acquire', 'normalize', 'chapter', 'jev_terms', 'note'])
      expect(step('chapter').querySelector('strong')).toHaveTextContent('理解视频 · gpt-6-sol')
      expect(step('jev_terms').querySelector('strong')).toHaveTextContent('Jev 筛选术语 · jev-1.13.0')
      expect(step('jev_terms')).toHaveAttribute('data-stage-state', 'completed')
      expect(step('note').querySelector('strong')?.textContent).toBe('整理知识笔记')
      expect(step('note')).toHaveAttribute('data-stage-state', 'active')
      expect(step('acquire').querySelector('strong')?.textContent).toBe('采集与转写')
      expect(steps.querySelectorAll('.vk-task-detail-step-content > span')).toHaveLength(5)
      expect(details).toHaveTextContent('阶段 3 / 4')
    })

    it('「模型配置」只列大模型渠道,不含 Jev', async () => {
      await openJevJob(jevJob({
        completed_stages: ['acquire', 'normalize', 'chapter', 'jev_terms', 'note', 'product'],
        stage_metrics: [stageMetric('chapter', 'done', 8), stageMetric('jev_terms', 'done', 0.6)],
        model_attempts: [modelAttempt('chapter'), jevAttempt('jev_terms')],
      }))
      const metadata = screen.getByTestId('vk-task-detail-metadata')
      expect(within(metadata).getByText('主站')).toBeInTheDocument()
      expect(metadata.textContent).not.toMatch(/typesafe|jev/i)
    })

    it('Jev 被跳过:Minus 图标、整行变暗,原因写成「已跳过：…」,且不会被当成最新一步', async () => {
      const { steps, step } = await openJevJob(jevJob({
        completed_stages: ['acquire', 'normalize', 'chapter'],
        stage_metrics: [
          stageMetric('chapter', 'done', 8),
          stageMetric('jev_terms', 'skipped', 0.3, 'HTTP 451：该地区暂不提供服务'),
        ],
        model_attempts: [modelAttempt('chapter'), jevAttempt('jev_terms', { model_reported: '', status: 'transient_error' })],
      }, 'running'))

      const jev = step('jev_terms')
      expect(jev).toHaveAttribute('data-stage-state', 'skipped')
      expect(jev).toHaveClass('is-skipped')
      expect(within(jev).getByLabelText('已跳过')).toBeInTheDocument()
      expect(jev).toHaveTextContent('已跳过：HTTP 451：该地区暂不提供服务')
      expect(jev.querySelector('strong')).toHaveTextContent('Jev 筛选术语 · jev-latest')
      expect(steps.querySelectorAll('.vk-task-detail-step-connector.is-skipped')).toHaveLength(1)
      expect(steps.querySelector('[data-stage-state="active"]')).toBeNull()
      expect(steps.querySelector('[aria-current="step"]')).toBeNull()
    })

    it('旧引擎 skipped 阶段的原始错误码走失败文案映射,不直接显示;没有原因时只写「已跳过」', async () => {
      const { step } = await openJevJob(jevJob({
        completed_stages: ['acquire', 'chapter'],
        stage_metrics: [
          stageMetric('normalize', 'skipped', 0, 'missing_transcript'),
          stageMetric('chapter', 'done', 8),
          stageMetric('jev_terms', 'skipped', 0),
        ],
      }))

      const legacy = step('normalize')
      expect(legacy).toHaveAttribute('data-stage-state', 'skipped')
      expect(within(legacy).getByTestId('vk-failure-note')).toBeInTheDocument()
      expect(legacy).not.toHaveTextContent('已跳过：missing_transcript')
      expect(within(legacy).getByText('missing_transcript').closest('details')).not.toBeNull()
      const plain = step('jev_terms')
      expect(plain).toHaveAttribute('data-stage-state', 'skipped')
      expect(plain.querySelector('.vk-task-detail-step-reason')?.textContent).toBe('已跳过')
    })

    it('skipped 阶段的 missing_transcript 显示「没有拿到字幕或语音转写」,原码收在原始信息里', async () => {
      const { step } = await openJevJob(jevJob({
        completed_stages: ['acquire', 'chapter'],
        stage_metrics: [
          stageMetric('normalize', 'skipped', 0, 'missing_transcript'),
          stageMetric('chapter', 'done', 8),
        ],
      }))

      const skipped = step('normalize')
      const note = within(skipped).getByTestId('vk-failure-note')
      expect(note).toHaveAttribute('data-kind', 'no-transcript')
      expect(note).toHaveTextContent('没有拿到字幕或语音转写')
      expect(skipped).not.toHaveTextContent('解析失败')
      const raw = within(skipped).getByText('missing_transcript')
      expect(raw.tagName).toBe('PRE')
      expect(raw.closest('details')).not.toBeNull()
    })

    it('skipped 阶段认不出的原始错误码只说「这一步没有执行」,原码收在原始信息里', async () => {
      const { step } = await openJevJob(jevJob({
        completed_stages: ['acquire', 'chapter'],
        stage_metrics: [
          stageMetric('normalize', 'skipped', 0, 'missing_visual_frames'),
          stageMetric('chapter', 'done', 8),
        ],
      }))

      const skipped = step('normalize')
      expect(skipped).toHaveAttribute('data-stage-state', 'skipped')
      expect(within(skipped).queryByTestId('vk-failure-note')).toBeNull()
      expect(skipped).not.toHaveTextContent('解析失败')
      const reason = skipped.querySelector('.vk-task-detail-step-reason')!
      expect(reason.firstChild?.textContent).toBe('已跳过：这一步没有执行')
      const raw = within(skipped).getByText('missing_visual_frames')
      expect(raw.tagName).toBe('PRE')
      expect(raw.closest('details')).not.toBeNull()
    })

    it('skipped 阶段的 HTTP 限流或故障原因按原样显示,不翻成模型服务限流或故障', async () => {
      const { step } = await openJevJob(jevJob({
        completed_stages: ['acquire', 'normalize', 'chapter'],
        stage_metrics: [
          stageMetric('chapter', 'done', 8),
          stageMetric('jev_terms', 'skipped', 0.3, 'HTTP 429：请求过于频繁'),
        ],
      }, 'running'))

      const jev = step('jev_terms')
      expect(jev).toHaveTextContent('已跳过：HTTP 429：请求过于频繁')
      expect(within(jev).queryByTestId('vk-failure-note')).toBeNull()
      expect(jev).not.toHaveTextContent('模型服务')
    })

    it('只出现一次的阶段不显示「×N」,用时仍取该次指标', async () => {
      const { step } = await openJevJob(jevJob({
        completed_stages: ['acquire', 'normalize', 'chapter', 'jev_terms', 'note', 'product'],
        stage_metrics: [stageMetric('chapter', 'done', 7.25), stageMetric('jev_terms', 'done', 0.5)],
      }))
      expect(step('chapter').querySelector('strong')?.textContent).toBe('理解视频')
      expect(step('chapter').querySelector('.vk-task-detail-step-content > span')).toHaveTextContent('7.25s')
      expect(step('jev_terms').querySelector('.vk-task-detail-step-content > span')).toHaveTextContent('500ms')
      expect(step('jev_terms').textContent).not.toContain('×')
    })
  })
})

describe('批次顶部状态与排队显示', () => {
  type Member = { job_id: string; status: string }
  const settledAt = (status: string, index: number) =>
    status === 'queued' || status === 'running' ? null : `2026-09-05T00:01:0${index}Z`

  // members 是可变数组:改状态就等于引擎推进了一步,下一次请求读到新值。
  const stubBatch = (members: Member[], batchId: string | null = 'batch-top') => {
    const view = (member: Member, index: number) => ({
      job_id: member.job_id, kind: 'run', status: member.status, batch_id: batchId,
      submitted_at: `2026-09-05T00:00:0${index}Z`, finished_at: settledAt(member.status, index),
      parent_job_id: null, cache_bypass: false,
    })
    const sourceOf = (member: Member) => `https://example.com/${member.job_id}`
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/vk/v1/providers') return new Response(JSON.stringify({ channels: [], roles: {} }))
      if (path === '/vk/v1/jobs') {
        return new Response(JSON.stringify(members.map((member, index) => ({ ...view(member, index), source: sourceOf(member) }))))
      }
      const index = members.findIndex((member) => path === `/vk/v1/jobs/${member.job_id}`)
      if (index < 0) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({
        ...view(members[index], index), request: { source: sourceOf(members[index]), preset: 'quick-summary' },
      }))
    }))
    return members
  }
  const members = (...statuses: string[]): Member[] => statuses.map((status, index) => ({ job_id: `m-${index}`, status }))
  const badge = () => document.querySelector('.vk-task-detail-badge') as HTMLElement
  const rowOf = (jobId: string) => screen.getByTestId(`vk-task-detail-task-row-${jobId}`).closest('li')!
  const open = async (jobId: string, lastMember: string) => {
    render(<VkTaskDetailSidebar jobId={jobId} baseUrl={BASE} onClose={() => {}} />)
    await screen.findByTestId(`vk-task-detail-task-row-${lastMember}`)
  }

  it.each([
    [['done', 'running'], '正在执行', 'is-running'],
    [['done', 'queued'], '正在执行', 'is-running'],
    [['failed', 'queued', 'running'], '正在执行', 'is-running'],
    [['done', 'failed'], '部分成功', 'is-partial'],
    [['done', 'cancelled'], '部分成功', 'is-partial'],
    [['done', 'partial'], '部分成功', 'is-partial'],
    [['done', 'done'], '已完成', 'is-completed'],
    [['failed', 'failed'], '失败', 'is-failed'],
    [['cancelled', 'interrupted'], '已中断', 'is-interrupted'],
    [['partial', 'partial'], '部分完成', 'is-partial'],
  ])('成员 %j 时,打开第一条,顶部状态是「%s」', async (statuses, label, className) => {
    stubBatch(members(...statuses))
    await open('m-0', `m-${statuses.length - 1}`)

    expect(badge()).toHaveTextContent(label)
    expect(badge()).toHaveClass(className)
  })

  it('打开的这条已经完成,批里还有成员在跑时,顶部不能先说「已完成」', async () => {
    const batch = stubBatch(members('done', 'running'))
    const polls = captureMemberPolling()
    await open('m-0', 'm-1')
    expect(badge()).toHaveTextContent('正在执行')
    expect(rowOf('m-0')).toHaveTextContent('已完成')

    batch[1].status = 'failed'
    await act(async () => { await Promise.all([...polls.values()].map((poll) => poll())) })
    await waitFor(() => expect(badge()).toHaveTextContent('部分成功'))
  })

  it('排队中的小任务显示「排队中」、没有耗时,运行中的照常带耗时,也不算已处理', async () => {
    const user = userEvent.setup()
    stubBatch(members('running', 'queued'))
    await open('m-0', 'm-1')

    const queued = rowOf('m-1')
    expect(queued).toHaveAttribute('data-state', 'queued')
    expect(queued).toHaveAttribute('data-color', 'neutral')
    expect(queued).toHaveTextContent('排队中')
    expect(queued).not.toHaveTextContent('耗时')
    expect(queued).not.toHaveTextContent('进行中')
    expect(rowOf('m-0')).toHaveTextContent('进行中')
    expect(rowOf('m-0')).toHaveTextContent('耗时')
    expect(screen.getByTestId('vk-task-detail-sources')).toHaveTextContent('已处理 0/2')

    await user.click(screen.getByTestId('vk-task-detail-task-row-m-1'))
    const queuedDetails = await within(queued).findByTestId('vk-task-detail-stage-details')
    expect(queuedDetails).toHaveTextContent('排队中，等待空闲名额')
    expect(queuedDetails).not.toHaveTextContent('等待阶段数据')
    await user.click(screen.getByTestId('vk-task-detail-task-row-m-0'))
    expect(await within(rowOf('m-0')).findByTestId('vk-task-detail-stage-details')).toHaveTextContent('等待阶段数据')
  })

  it('样式表为排队中配了独立的中性色', () => {
    const css = readFileSync(resolve(import.meta.dirname, 'VkTaskDetailSidebar.css'), 'utf8')
    expect(css).toContain(".vk-task-detail-task-row[data-state='queued']")
    expect(css).toContain('.vk-task-detail-batch-status.is-queued')
  })

  it('单视频任务排队中:顶部仍是「正在执行」,任务行显示「排队中」且没有耗时', async () => {
    stubBatch(members('queued'), null)
    render(<VkTaskDetailSidebar jobId="m-0" baseUrl={BASE} onClose={() => {}} />)
    const row = (await screen.findByTestId('vk-task-detail-task-row-source-0')).closest('li')!

    expect(badge()).toHaveTextContent('正在执行')
    expect(row).toHaveTextContent('排队中')
    expect(row).not.toHaveTextContent('耗时')
  })

  it('排队中的小任务不能重跑,选择菜单里置灰并标明排队中', async () => {
    const user = userEvent.setup()
    stubBatch(members('done', 'failed', 'queued'))
    await open('m-0', 'm-2')

    expect(await screen.findByRole('button', { name: /重跑小任务2/ })).toBeInTheDocument()
    expect(screen.getByTestId('vk-task-detail-sources')).toHaveTextContent('已处理 2/3')
    await user.click(screen.getByRole('button', { name: '展开小任务选择' }))
    const option = within(await screen.findByRole('menu')).getByRole('menuitemcheckbox', { name: /小任务3/ })
    expect(option).toBeDisabled()
    expect(option).toHaveTextContent('排队中')
    expect(option).toHaveAttribute('data-color', 'neutral')
  })

  it('只剩排队中的成员也继续轮询,拿到名额后带上耗时,全部落定后停止轮询', async () => {
    const polls = captureMemberPolling()
    const batch = stubBatch(members('done', 'queued'))
    await open('m-0', 'm-1')
    await waitFor(() => expect(polls.size).toBe(1))
    expect(rowOf('m-1')).not.toHaveTextContent('耗时')

    batch[1].status = 'running'
    await act(async () => { await Promise.all([...polls.values()].map((poll) => poll())) })
    await waitFor(() => expect(rowOf('m-1')).toHaveAttribute('data-state', 'running'))
    expect(rowOf('m-1')).toHaveTextContent('耗时')
    expect(polls.size).toBe(1)
    expect(badge()).toHaveTextContent('正在执行')

    batch[1].status = 'done'
    await act(async () => { await Promise.all([...polls.values()].map((poll) => poll())) })
    await waitFor(() => expect(badge()).toHaveTextContent('已完成'))
    expect(screen.getByTestId('vk-task-detail-sources')).toHaveTextContent('已处理 2/2')
    expect(polls.size).toBe(0)
  })
})
