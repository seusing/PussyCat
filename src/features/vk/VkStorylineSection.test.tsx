import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VkStorylineSection } from './VkStorylineSection'
import type { VkStorylineRow } from '../../host/vkClient'

const BASE = 'http://127.0.0.1:17373'

const row = (over: Partial<VkStorylineRow> = {}): VkStorylineRow => ({
  storyline_id: 'sl_1', batch_id: 'batch-1', status: 'done', trigger: 'auto',
  requested_at: '2026-09-01T00:00:00Z', started_at: null, finished_at: null,
  error: null, reason: null, storyline_count: 2, standalone_count: 1, cost_cny: null,
  ...over,
})

/** 模拟 Host 的 /storylines:rows 为 null 时表示旧引擎(404)。 */
function stubStorylineApi(initial: VkStorylineRow[] | null, postStatus = 201) {
  const state = { rows: initial, posts: [] as unknown[], lists: 0 }
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (init?.method === 'POST') {
      state.posts.push(JSON.parse(String(init.body)))
      if (postStatus >= 400) return new Response(JSON.stringify({ error: '批次不存在' }), { status: postStatus })
      state.rows = [row({ status: 'queued', trigger: 'manual' })]
      return new Response(JSON.stringify({ storyline_id: 'sl_1', status: 'queued' }), { status: postStatus })
    }
    state.lists += 1
    if (url.pathname !== '/vk/v1/storylines' || state.rows === null) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    }
    expect(url.searchParams.get('batch_id')).toBe('batch-1')
    return new Response(JSON.stringify(state.rows))
  })
  vi.stubGlobal('fetch', impl)
  return state
}

function captureIntervals() {
  const timers = new Map<number, { delay: number; run: () => void }>()
  let next = 1000
  vi.spyOn(window, 'setInterval').mockImplementation(((run: () => void, delay?: number) => {
    timers.set(next, { delay: delay ?? 0, run })
    return next++
  }) as unknown as typeof window.setInterval)
  vi.spyOn(window, 'clearInterval').mockImplementation(((id: number) => { timers.delete(id) }) as unknown as typeof window.clearInterval)
  return timers
}

function renderSection(props: { parsedCount?: number; onView?: () => void } = {}) {
  return render(<VkStorylineSection batchId="batch-1" baseUrl={BASE} parsedCount={props.parsedCount ?? 3} onView={props.onView ?? (() => {})} />)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('VkStorylineSection', () => {
  it('renders nothing when the engine has no storyline API (404)', async () => {
    const state = stubStorylineApi(null)
    renderSection()
    await waitFor(() => expect(state.lists).toBe(1))
    await act(async () => {})
    expect(screen.queryByTestId('vk-storyline-section')).not.toBeInTheDocument()
    expect(state.posts).toEqual([])
  })

  it('without any record shows no status line and lets a batch with two parsed videos start', async () => {
    stubStorylineApi([])
    renderSection({ parsedCount: 2 })
    const start = await screen.findByTestId('vk-storyline-start')
    expect(screen.queryByTestId('vk-storyline-status')).not.toBeInTheDocument()
    expect(start).toHaveTextContent('串联分析')
    expect(start).toBeEnabled()
    expect(start).not.toHaveAttribute('title')
    expect(screen.queryByTestId('vk-storyline-view')).not.toBeInTheDocument()
  })

  it('disables the start button with a reason when fewer than two videos parsed', async () => {
    stubStorylineApi([])
    renderSection({ parsedCount: 1 })
    const start = await screen.findByTestId('vk-storyline-start')
    expect(start).toBeDisabled()
    expect(start).toHaveAttribute('title', '至少需要 2 个解析成功的视频')
  })

  it.each([
    ['waiting', '等本批全部解析完再串联'],
    ['queued', '排队中'],
    ['running', '串联中…'],
  ] as const)('%s 记录显示「%s」并禁止重复发起', async (status, text) => {
    stubStorylineApi([row({ status })])
    renderSection()
    expect(await screen.findByTestId('vk-storyline-status')).toHaveTextContent(text)
    expect(screen.getByTestId('vk-storyline-start')).toBeDisabled()
    expect(screen.getByTestId('vk-storyline-start')).toHaveAttribute('title', '本批已有串联在进行中')
    expect(screen.queryByTestId('vk-storyline-view')).not.toBeInTheDocument()
  })

  it.each([
    [row({ status: 'done' }), '已串成 2 条故事线，1 个视频未归入', true],
    [row({ status: 'partial' }), '已串成 2 条故事线，1 个视频未归入。部分内容生成失败', true],
    [row({ status: 'done', storyline_count: 0, standalone_count: 3 }), '已串成 0 条故事线，3 个视频未归入', false],
    [row({ status: 'skipped', reason: '只有 1 个视频有字幕', storyline_count: null, standalone_count: null }), '可串联的视频不足 2 个（只有 1 个视频有字幕）', false],
    [row({ status: 'failed', error: '模型超时' }), '串联失败：模型超时', false],
  ] as const)('终态 %#:状态文案、重新串联与查看按钮', async (record, text, viewable) => {
    stubStorylineApi([record])
    renderSection()
    expect(await screen.findByTestId('vk-storyline-status')).toHaveTextContent(text)
    expect(screen.getByTestId('vk-storyline-start')).toBeEnabled()
    expect(screen.queryByTestId('vk-storyline-view') !== null).toBe(viewable)
  })

  it('opens the storylines from the view button', async () => {
    const onView = vi.fn()
    stubStorylineApi([row()])
    renderSection({ onView })
    await userEvent.click(await screen.findByTestId('vk-storyline-view'))
    expect(onView).toHaveBeenCalledTimes(1)
  })

  it('posts the batch id on click and then shows the refreshed status', async () => {
    const state = stubStorylineApi([])
    renderSection()
    await userEvent.click(await screen.findByTestId('vk-storyline-start'))
    await waitFor(() => expect(screen.getByTestId('vk-storyline-status')).toHaveTextContent('排队中'))
    expect(state.posts).toEqual([{ batch_id: 'batch-1' }])
    expect(screen.getByTestId('vk-storyline-start')).toBeDisabled()
  })

  it('shows the failure and keeps the button usable when starting is rejected', async () => {
    stubStorylineApi([], 404)
    renderSection()
    await userEvent.click(await screen.findByTestId('vk-storyline-start'))
    expect(await screen.findByRole('alert')).toHaveTextContent('批次不存在')
    expect(screen.getByTestId('vk-storyline-start')).toBeEnabled()
  })

  it('polls every 15 seconds while a record is in progress and stops once it is terminal', async () => {
    const timers = captureIntervals()
    const state = stubStorylineApi([row({ status: 'waiting' })])
    renderSection()
    await screen.findByTestId('vk-storyline-status')
    const polls = () => [...timers.values()].filter((timer) => timer.delay === 15_000)
    expect(polls()).toHaveLength(1)

    state.rows = [row({ status: 'running' })]
    await act(async () => { polls()[0].run() })
    await waitFor(() => expect(screen.getByTestId('vk-storyline-status')).toHaveTextContent('串联中…'))
    expect(polls()).toHaveLength(1)

    state.rows = [row({ status: 'done' })]
    await act(async () => { polls()[0].run() })
    await waitFor(() => expect(screen.getByTestId('vk-storyline-status')).toHaveTextContent('已串成 2 条故事线'))
    expect(polls()).toHaveLength(0)
  })

  it('does not poll when nothing is in progress', async () => {
    const timers = captureIntervals()
    stubStorylineApi([row({ status: 'done' })])
    renderSection()
    await screen.findByTestId('vk-storyline-status')
    expect(timers.size).toBe(0)
  })
})
