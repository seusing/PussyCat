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
  it('列表上的任务编号要出现在详情页,提交内容排在模型配置之前', async () => {
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
    // 「查看解析结果」和「再次提交任务」是同一时刻的两个选择,并排放在操作区。
    const actions = panel.querySelector('.vk-task-detail-actions')
    expect(actions?.textContent).toContain('查看解析结果')
    expect(actions?.textContent).toContain('再次提交任务')
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
    expect(panel).toHaveTextContent('共 3 个视频 · 已完成 2/3')
    expect(panel).toHaveTextContent('https://example.com/two')
    await user.click(screen.getByText('https://example.com/three'))
    expect(onJobChange).toHaveBeenCalledWith('b-3')
  })

  it('renders real stage progress and the configured model name', async () => {
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

    const progress = await screen.findByRole('progressbar', { name: '处理阶段进度' })
    expect(progress).toHaveAttribute('aria-valuenow', '25')
    expect(progress).toHaveAttribute('aria-valuemax', '100')
    expect(screen.getByText('阶段 2 / 4')).toBeInTheDocument()
    expect(screen.getByText('理解视频重点')).toBeInTheDocument()
    expect(screen.getByText('我的总结模型')).toBeInTheDocument()
    expect(screen.getByText('https://www.youtube.com/watch?v=1')).toBeInTheDocument()
    expect(screen.getByText('https://www.bilibili.com/video/BV1')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('任务正在执行')).toBeInTheDocument())
  })

  it('uses five phases when a historical quick preset actually reaches claim', async () => {
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

    expect(await screen.findByText('阶段 3 / 5')).toBeInTheDocument()
    expect(screen.getByText('核对关键信息')).toBeInTheDocument()
  })

  it('shows real stage timing and token usage without cost or cache clutter', async () => {
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

    const metrics = await screen.findByTestId('vk-run-metrics')
    expect(metrics).toHaveTextContent('输入 1,234')
    expect(metrics).toHaveTextContent('输出 321')
    // 费用与缓存 Token 已从详情页移除：缓存恒为 0，费用因通道普遍不提供可信价格
    // 而长期是'未统计'，两个格子只占地方。
    expect(metrics).not.toHaveTextContent('费用')
    expect(metrics).not.toHaveTextContent('缓存')
    const stages = screen.getByTestId('vk-stage-metrics')
    expect(stages).toHaveTextContent('采集与转写')
    expect(stages).toHaveTextContent('2.50 秒')
    expect(stages).toHaveTextContent('理解视频')
    expect(stages).toHaveTextContent('7.25 秒')
    expect(stages).toHaveTextContent('custom-stage')
  })

  it('shows every actual model attempt and explains a configured fallback switch', async () => {
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

    const attempts = await screen.findByTestId('vk-model-attempts')
    expect(attempts).toHaveTextContent('第 1 次 · 主站')
    expect(attempts).toHaveTextContent('临时故障')
    expect(attempts).toHaveTextContent('第 2 次 · 备用站')
    expect(attempts).toHaveTextContent('已按你的备用顺序切换')
    expect(attempts).toHaveTextContent('同步')
    expect(attempts).toHaveTextContent('首字不可测')
    expect(attempts).toHaveTextContent('推理强度 未记录')
    expect(attempts).toHaveTextContent('输出上限 未记录')
    expect(screen.getByText('主站 → 备用站')).toBeInTheDocument()
    expect(attempts).not.toHaveTextContent('https://')
  })

  it('shows streaming telemetry and an abandoned billing warning', async () => {
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

    const attempts = await screen.findByTestId('vk-model-attempts')
    expect(attempts).toHaveTextContent('已停止等待')
    expect(attempts).toHaveTextContent('流式')
    expect(attempts).toHaveTextContent('响应头 42 ms')
    expect(attempts).toHaveTextContent('首事件 61 ms')
    expect(attempts).toHaveTextContent('首字 93 ms')
    expect(attempts).toHaveTextContent('首推理事件 71 ms')
    expect(attempts).toHaveTextContent('最后事件 response.reasoning_summary_text.delta（30499 ms）')
    expect(attempts).toHaveTextContent('终止事件 未记录')
    expect(attempts).toHaveTextContent('[DONE] 未收到')
    expect(attempts).toHaveTextContent('response.created')
    expect(attempts).toHaveTextContent('总耗时 30500 ms')
    expect(attempts).toHaveTextContent('推理强度 medium')
    expect(attempts).toHaveTextContent('输出上限 2,048')
    expect(screen.getByRole('alert')).toHaveTextContent(
      '上游可能仍在运行和计费；系统没有自动重试',
    )
    expect(screen.getByTestId('vk-run-metrics')).not.toHaveTextContent('待对账')
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

  it('opens the canonical result inside the app', async () => {
    const user = userEvent.setup()
    const opened: Array<{ outputId?: string; title?: string }> = []
    const listener = (event: Event) => {
      opened.push((event as CustomEvent<{ outputId?: string; title?: string }>).detail)
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

    expect(opened).toEqual([{ outputId: 'outputs/note.md', title: '解析结果' }])
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
    expect(await screen.findByText('已中断')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '再次提交任务' })).toBeInTheDocument()
    expect(screen.queryByText('解析结果')).not.toBeInTheDocument()
  })
})
