import userEvent from '@testing-library/user-event'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VkTaskDetailSidebar } from './VkTaskDetailSidebar'

const BASE = 'http://127.0.0.1:17373'

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: (props: { 'aria-label'?: string; state?: string; speed?: number }) => (
    <div aria-label={props['aria-label']} data-state={props.state} data-speed={props.speed} />
  ),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('VkTaskDetailSidebar', () => {
  it('renders real link progress and the configured model name', async () => {
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
          progress: { completed_links: 1, total_links: 2 },
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

    const progress = await screen.findByRole('progressbar', { name: '链接处理进度' })
    expect(progress).toHaveAttribute('aria-valuenow', '1')
    expect(progress).toHaveAttribute('aria-valuemax', '2')
    expect(screen.getByText('我的总结模型')).toBeInTheDocument()
    expect(screen.getByText('https://www.youtube.com/watch?v=1')).toBeInTheDocument()
    expect(screen.getByText('https://www.bilibili.com/video/BV1')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('任务正在执行')).toBeInTheDocument())
  })

  it('活跃任务在详情轮询返回终态后立即切换为失败界面', async () => {
    let jobRequest = 0
    let poll: (() => Promise<void>) | undefined
    vi.stubGlobal('setInterval', (callback: TimerHandler, delay?: number) => {
      if (delay === 1500) {
        poll = callback as () => Promise<void>
      }
      return 999_999
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

    expect(await screen.findByText('失败')).toBeInTheDocument()
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
    expect(screen.queryByRole('button', { name: '强制重跑' })).not.toBeInTheDocument()
  })

  it('resubmits a completed task as a new job and marks the fresh execution as rerunning', async () => {
    const user = userEvent.setup()
    const onJobChange = vi.fn()
    let submitBody = ''
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/jobs/completed')) return new Response(JSON.stringify({
        job_id: 'completed', kind: 'run', status: 'done', submitted_at: '2026-08-07T10:00:00Z', finished_at: '2026-08-07T10:01:00Z',
        parent_job_id: null, cache_bypass: false, request: { source: 'https://example.com/v', preset: 'quick-summary' },
      }), { status: 200 })
      if (url.endsWith('/vk/v1/providers')) return new Response(JSON.stringify({ channels: [], roles: {} }), { status: 200 })
      if (url.endsWith('/vk/v1/jobs') && init?.method === 'POST') {
        submitBody = String(init.body)
        return new Response(JSON.stringify({ job_id: 'fresh-job', kind: 'request' }), { status: 201 })
      }
      return new Response('{}', { status: 404 })
    }))
    render(<VkTaskDetailSidebar jobId="completed" baseUrl={BASE} onClose={() => {}} onJobChange={onJobChange} />)
    await user.click(await screen.findByRole('button', { name: '再次提交任务' }))
    await waitFor(() => expect(onJobChange).toHaveBeenCalledWith('fresh-job'))
    expect(JSON.parse(submitBody)).toMatchObject({ request: { source: 'https://example.com/v', preset: 'quick-summary' } })
  })

  it('shows an interrupted child as rerunning with the solving animation', async () => {
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
    expect(screen.getByLabelText('任务重跑中')).toHaveAttribute('data-state', 'solving')
    expect(screen.getByLabelText('任务重跑中')).toHaveAttribute('data-speed', '0.9')
    expect(screen.getByRole('button', { name: '停止任务' })).toBeInTheDocument()
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
    expect(await screen.findByText('已中断')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '再次提交任务' })).toBeInTheDocument()
    expect(screen.queryByText('解析结果')).not.toBeInTheDocument()
  })
})
