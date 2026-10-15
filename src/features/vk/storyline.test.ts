import type { VkComparison, VkStorylineResult, VkStorylineRow } from '../../host/vkClient'
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

const comparison = (id: string, title: string, over: Partial<VkComparison> = {}): VkComparison => ({
  id, title, logline: '', members: [], common_points: [], differences: [], unique_points: [], action_items: [],
  markdown: `# 观点对比 · ${title}\n\n正文`, markdown_path: '',
  ...over,
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

  it.each([
    [{ comparison_count: 1 }, '已串成 2 条故事线、1 组观点对比，1 个视频未归入'],
    [{ comparison_count: 3, standalone_count: 0 }, '已串成 2 条故事线、3 组观点对比'],
    [{ comparison_count: null }, '已串成 2 条故事线，1 个视频未归入'],
    [{ storyline_count: 0, comparison_count: 2 }, '已整理出 2 组观点对比，1 个视频未归入'],
    [{ storyline_count: 0, comparison_count: 2, standalone_count: 0 }, '已整理出 2 组观点对比'],
    [{ storyline_count: 1, standalone_count: 0 }, '已串成 1 条故事线'],
    [{ storyline_count: 1, standalone_count: null }, '已串成 1 条故事线'],
    [{ storyline_count: 0, standalone_count: 3 }, '这批视频之间没有发现关联，各自保留单独笔记'],
    [{ storyline_count: 0, comparison_count: 0, standalone_count: 3 }, '这批视频之间没有发现关联，各自保留单独笔记'],
    [{ storyline_count: null, standalone_count: null }, '这批视频之间没有发现关联，各自保留单独笔记'],
  ] as [Partial<VkStorylineRow>, string][])('done %j → %s', (over, text) => {
    expect(storylineStatusText(row({ status: 'done', ...over }))).toBe(text)
  })

  it.each([
    [{ comparison_count: 1 }, '已串成 2 条故事线、1 组观点对比，1 个视频未归入。部分内容生成失败'],
    [{ storyline_count: 0, comparison_count: 2, standalone_count: 0 }, '已整理出 2 组观点对比。部分内容生成失败'],
    [{ storyline_count: 0, standalone_count: 3 }, '没有串成故事线，部分内容生成失败'],
  ] as [Partial<VkStorylineRow>, string][])('partial %j → %s', (over, text) => {
    expect(storylineStatusText(row({ status: 'partial', ...over }))).toBe(text)
  })

  it('appends the reason in parentheses at the very end of a done or partial record', () => {
    expect(storylineStatusText(row({ status: 'done', comparison_count: 0, reason: '未做跨博主对比：HTTP 451：…' })))
      .toBe('已串成 2 条故事线，1 个视频未归入（未做跨博主对比：HTTP 451：…）')
    expect(storylineStatusText(row({ status: 'partial', reason: '1 个视频摘要失败' })))
      .toBe('已串成 2 条故事线，1 个视频未归入。部分内容生成失败（1 个视频摘要失败）')
    expect(storylineStatusText(row({ status: 'done', storyline_count: 0, comparison_count: 0, reason: '本批视频超过 24 个，未做跨博主对比' })))
      .toBe('这批视频之间没有发现关联，各自保留单独笔记（本批视频超过 24 个，未做跨博主对比）')
    expect(storylineStatusText(row({ status: 'partial', storyline_count: 0, comparison_count: 0, reason: '1 个视频摘要失败' })))
      .toBe('没有串成故事线，部分内容生成失败（1 个视频摘要失败）')
  })
})

describe('storylineViewable', () => {
  it('needs a done or partial record with at least one storyline or comparison', () => {
    expect(storylineViewable(row({ status: 'done' }))).toBe(true)
    expect(storylineViewable(row({ status: 'partial' }))).toBe(true)
    expect(storylineViewable(row({ status: 'done', storyline_count: 0 }))).toBe(false)
    expect(storylineViewable(row({ status: 'skipped' }))).toBe(false)
    expect(storylineViewable(row({ status: 'running' }))).toBe(false)
    expect(storylineViewable(undefined)).toBe(false)
  })

  it('counts comparisons, and treats a null or missing comparison_count as zero', () => {
    expect(storylineViewable(row({ status: 'done', storyline_count: 0, comparison_count: 1 }))).toBe(true)
    expect(storylineViewable(row({ status: 'partial', storyline_count: 0, comparison_count: 2 }))).toBe(true)
    expect(storylineViewable(row({ status: 'done', storyline_count: 0, comparison_count: 0 }))).toBe(false)
    expect(storylineViewable(row({ status: 'done', storyline_count: 0, comparison_count: null }))).toBe(false)
    expect(storylineViewable(row({ status: 'done', storyline_count: null, comparison_count: 1 }))).toBe(true)
    expect(storylineViewable(row({ status: 'running', storyline_count: null, comparison_count: 1 }))).toBe(false)
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

  it('carries the storyline terms onto the tab and leaves the key out when there are none', () => {
    const terms = [
      { term: '渐进式超负荷', explanation: '逐步增加训练负荷', in_video: '每次加 2.5 公斤', job_id: 'a', video_title: '第一集' },
      { term: '减载', explanation: '主动降低训练量', in_video: '每四周一次', job_id: 'b', video_title: '第二集' },
    ]
    const tabs = storylineTabs(result({
      storylines: [
        { ...story('s1', '装修日记', [episode(1, 'a')]), terms },
        { ...story('s2', '旅行', [episode(1, 'd')]), terms: [] },
        story('s3', '无术语', [episode(1, 'c')]),
      ],
    }))
    expect(tabs[0].terms).toEqual(terms)
    expect(tabs[1]).not.toHaveProperty('terms')
    expect(tabs[2]).not.toHaveProperty('terms')
  })

  it('appends one inline-markdown tab per comparison after the storyline tabs', () => {
    const terms = [
      { term: '视界', explanation: '黑洞的单向边界', in_video: '视界是单向膜', job_id: 'a', video_title: '黑洞漫谈 第1期' },
    ]
    const tabs = storylineTabs(result({
      comparisons: [
        comparison('c1', '黑洞视界', { terms }),
        comparison('c2', '训练方法'),
        comparison('c3', '空术语', { terms: [] }),
      ],
    }))
    expect(tabs.map((tab) => tab.label)).toEqual([
      '故事线 · 装修日记', '故事线 · 旅行', '观点对比 · 黑洞视界', '观点对比 · 训练方法', '观点对比 · 空术语',
    ])
    expect(tabs[2]).toMatchObject({
      id: 'comparison:sl_1:c1',
      content: '# 观点对比 · 黑洞视界\n\n正文',
      libraryTitle: '观点对比 · 黑洞视界',
      terms,
    })
    expect(tabs[2].jobId).toBeUndefined()
    expect(tabs[2].outputId).toBeUndefined()
    expect(tabs[3]).not.toHaveProperty('terms')
    expect(tabs[4]).not.toHaveProperty('terms')
  })

  it('keeps comparison tab ids distinct from storyline tab ids even when the item ids match', () => {
    const tabs = storylineTabs(result({
      storylines: [story('s1', '装修日记', [episode(1, 'a')])],
      comparisons: [comparison('s1', '装修')],
    }))
    expect(tabs.map((tab) => tab.id)).toEqual(['storyline:sl_1:s1', 'comparison:sl_1:s1'])
  })

  it('builds comparison tabs alone when there is no storyline, and treats a missing comparisons key as none', () => {
    const only = storylineTabs(result({ storylines: [], comparisons: [comparison('c1', '黑洞视界')] }))
    expect(only.map((tab) => tab.label)).toEqual(['观点对比 · 黑洞视界'])
    expect(storylineTabs(result()).map((tab) => tab.label)).toEqual(['故事线 · 装修日记', '故事线 · 旅行'])
    expect(storylineTabs(result({ comparisons: [] }))).toHaveLength(2)
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

  it('returns comparison tabs for a record that has comparisons but no storylines', async () => {
    const record = row({ storyline_count: 0, comparison_count: 1 })
    stubFetch({
      '/vk/v1/storylines?batch_id=batch-1': { body: [record] },
      '/vk/v1/storylines/sl_1': {
        body: { ...record, result: result({ storylines: [], comparisons: [comparison('c1', '黑洞视界')] }) },
      },
    })
    const tabs = await loadStorylineTabs('batch-1', 'http://h')
    expect(tabs.map((tab) => tab.label)).toEqual(['观点对比 · 黑洞视界'])
  })

  it.each([
    ['an engine without storylines (404)', {}],
    ['no records', { '/vk/v1/storylines?batch_id=batch-1': { body: [] } }],
    ['a running record', { '/vk/v1/storylines?batch_id=batch-1': { body: [row({ status: 'running' })] } }],
    ['a skipped record', { '/vk/v1/storylines?batch_id=batch-1': { body: [row({ status: 'skipped', storyline_count: null })] } }],
    ['a done record with neither storylines nor comparisons', {
      '/vk/v1/storylines?batch_id=batch-1': { body: [row({ storyline_count: 0, comparison_count: 0 })] },
    }],
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
