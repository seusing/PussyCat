import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VkTaskDetailSidebar } from './VkTaskDetailSidebar'

const BASE = 'http://127.0.0.1:17373'

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: (props: { 'aria-label'?: string }) => <div aria-label={props['aria-label']} />,
}))

afterEach(() => {
  vi.unstubAllGlobals()
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
})
