import type { VkStorylineResult, VkStorylineRow } from '../../host/vkClient'
import { loadStorylineTabs, storylineStatusText, storylineTabs, storylineViewable } from './storyline'

const row = (over: Partial<VkStorylineRow> = {}): VkStorylineRow => ({
  storyline_id: 'sl_1', batch_id: 'batch-1', status: 'done', trigger: 'auto',
  requested_at: '2026-09-01T00:00:00Z', started_at: null, finished_at: null,
  error: null, reason: null, storyline_count: 2, standalone_count: 1, cost_cny: null,
  ...over,
})

const member = (job_id: string, author: string | null) => ({
  job_id, run_id: `run-${job_id}`, title: job_id, url: `https://example.com/${job_id}`,
  platform: 'xiaohongshu', author, published_at: null, duration_ms: 1000,
})
const episode = (order: number, job_id: string) => ({
  order, job_id, title: job_id, url: `https://example.com/${job_id}`, published_at: null, role: '', summary: '',
})
const story = (id: string, title: string, episodes: ReturnType<typeof episode>[]) => ({
  id, title, logline: '', episodes, callbacks: [], key_points: [], open_threads: [],
  markdown: `# ${title}\n\n正文`, markdown_path: '',
})

function result(over: Partial<VkStorylineResult> = {}): VkStorylineResult {
  return {
    schema_version: 'storyline_result@1', storyline_id: 'sl_1', batch_id: 'batch-1',
    generated_at: '2026-09-01T00:10:00Z', status: 'done', reason: null,
    members: [member('a', '阿甲'), member('b', '阿乙'), member('c', '阿乙'), member('d', null)],
    storylines: [
      story('s1', '装修日记', [episode(2, 'b'), episode(1, 'a'), episode(3, 'c')]),
      story('s2', '旅行', [episode(1, 'd')]),
    ],
    standalone: [], links: [],
    ...over,
  }
}

function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const impl = vi.fn(async (url: string) => {
    const parsed = new URL(url)
    const route = routes[`${parsed.pathname}${parsed.search}`]
    const status = route?.status ?? (route ? 200 : 404)
    return { ok: status < 400, status, json: async () => route?.body ?? { error: 'not found' } }
  })
  vi.stubGlobal('fetch', impl)
  return impl
}

describe('storylineStatusText', () => {
  it.each([
    [{ status: 'waiting' }, '等本批全部解析完再串联'],
    [{ status: 'queued' }, '排队中'],
    [{ status: 'running' }, '串联中…'],
    [{ status: 'done' }, '已串成 2 条故事线，1 个视频未归入'],
    [{ status: 'partial' }, '已串成 2 条故事线，1 个视频未归入。部分内容生成失败'],
    [{ status: 'skipped' }, '可串联的视频不足 2 个'],
    [{ status: 'skipped', reason: '只有 1 个视频有字幕' }, '可串联的视频不足 2 个（只有 1 个视频有字幕）'],
    [{ status: 'failed', error: '模型超时' }, '串联失败'],
  ] as [Partial<VkStorylineRow>, string][])('%j → %s', (over, text) => {
    expect(storylineStatusText(row(over))).toBe(text)
  })
})

describe('storylineViewable', () => {
  it('needs a done or partial record with at least one storyline', () => {
    expect(storylineViewable(row({ status: 'done' }))).toBe(true)
    expect(storylineViewable(row({ status: 'partial' }))).toBe(true)
    expect(storylineViewable(row({ status: 'done', storyline_count: 0 }))).toBe(false)
    expect(storylineViewable(row({ status: 'skipped' }))).toBe(false)
    expect(storylineViewable(row({ status: 'running' }))).toBe(false)
    expect(storylineViewable(undefined)).toBe(false)
  })
})

describe('storylineTabs', () => {
  it('builds one inline-markdown tab per storyline, titled with the most common author', () => {
    const tabs = storylineTabs(result())
    expect(tabs.map((tab) => tab.label)).toEqual(['故事线 · 装修日记', '故事线 · 旅行'])
    expect(tabs[0]).toMatchObject({
      content: '# 装修日记\n\n正文',
      libraryTitle: '阿乙 · 装修日记',
      source: 'https://example.com/a',
    })
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(2)
    expect(tabs[0].jobId).toBeUndefined()
    expect(tabs[0].outputId).toBeUndefined()
  })

  it('falls back to the storyline title when no member has an author', () => {
    const tabs = storylineTabs(result())
    expect(tabs[1].libraryTitle).toBe('旅行')
  })

  it('takes the earliest-seen author on a tie', () => {
    const tie = result({
      members: [member('a', '阿甲'), member('b', '阿乙')],
      storylines: [story('s1', '系列', [episode(1, 'a'), episode(2, 'b')])],
    })
    expect(storylineTabs(tie)[0].libraryTitle).toBe('阿甲 · 系列')
  })
})

describe('loadStorylineTabs', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('reads the newest record of the batch and returns its storyline tabs', async () => {
    const impl = stubFetch({
      '/vk/v1/storylines?batch_id=batch-1': { body: [row(), row({ storyline_id: 'sl_0', status: 'failed' })] },
      '/vk/v1/storylines/sl_1': { body: { ...row(), result: result() } },
    })
    const tabs = await loadStorylineTabs('batch-1', 'http://h')
    expect(tabs).toHaveLength(2)
    expect(impl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/vk/v1/storylines', '/vk/v1/storylines/sl_1',
    ])
  })

  it.each([
    ['an engine without storylines (404)', {}],
    ['no records', { '/vk/v1/storylines?batch_id=batch-1': { body: [] } }],
    ['a running record', { '/vk/v1/storylines?batch_id=batch-1': { body: [row({ status: 'running' })] } }],
    ['a skipped record', { '/vk/v1/storylines?batch_id=batch-1': { body: [row({ status: 'skipped', storyline_count: null })] } }],
    ['a server error', { '/vk/v1/storylines?batch_id=batch-1': { status: 503, body: { error: 'down' } } }],
    ['a missing result', {
      '/vk/v1/storylines?batch_id=batch-1': { body: [row()] },
      '/vk/v1/storylines/sl_1': { body: { ...row(), result: null } },
    }],
  ] as [string, Record<string, { status?: number; body: unknown }>][])('returns no tabs for %s', async (_name, routes) => {
    stubFetch(routes)
    await expect(loadStorylineTabs('batch-1', 'http://h')).resolves.toEqual([])
  })
})
