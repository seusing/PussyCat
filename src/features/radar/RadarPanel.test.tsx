import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RadarPanel } from './RadarPanel'

const BASE = 'http://127.0.0.1:9999'

function ratings(over: Record<string, unknown> = {}) {
  return {
    day: '2026-08-05',
    timezone: 'Asia/Shanghai',
    updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    window: 'rolling_24h',
    windowHours: 24,
    source: 'public_cache',
    models: [
      { id: 'gpt-5.6-luna-max', label: 'GPT-5.6 Luna max', group: 'GPT-5.6 Luna', average: 8.8, count: 215 },
      { id: 'gpt-5.6-luna-low', label: 'GPT-5.6 Luna low', group: 'GPT-5.6 Luna', average: 6.1, count: 42 },
      { id: 'gpt-5.6-sol-xhigh', label: 'GPT-5.6 Sol xhigh', group: 'GPT-5.6 Sol', average: 8.0, count: 84 },
      { id: 'gpt-5.6-sol-low', label: 'GPT-5.6 Sol low', group: 'GPT-5.6 Sol', average: 4.7, count: 9 },
    ],
    cached: false,
    stale: false,
    ttlSeconds: 300,
    fetchedAt: Date.now(),
    ...over,
  }
}

function stubFetch(sequence: { status?: number; body: unknown }[]) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    const next = sequence[Math.min(calls.length - 1, sequence.length - 1)]
    return { ok: (next.status ?? 200) < 400, status: next.status ?? 200, json: async () => next.body }
  }))
  return calls
}

afterEach(() => { vi.unstubAllGlobals() })

test('按家族分组，样本多的家族排前面', async () => {
  stubFetch([{ body: ratings() }])
  render(<RadarPanel baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('radar-group-GPT-5.6 Luna')).toBeInTheDocument())
  const groups = screen.getAllByTestId(/^radar-group-/)
  expect(groups[0]).toHaveTextContent('GPT-5.6 Luna')   // 257 票
  expect(groups[1]).toHaveTextContent('GPT-5.6 Sol')    // 93 票
  expect(groups[0]).toHaveTextContent('257 票')
})

test('组内按分数从高到低', async () => {
  stubFetch([{ body: ratings() }])
  render(<RadarPanel baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('radar-model-gpt-5.6-luna-max')).toBeInTheDocument())
  const rows = within(screen.getByTestId('radar-group-GPT-5.6 Luna')).getAllByTestId(/^radar-model-/)
  expect(rows[0]).toHaveTextContent('8.8')
  expect(rows[1]).toHaveTextContent('6.1')
})

test('样本量和分数一起给，低样本压暗并标出来 —— 9 票的 4.7 说明不了什么', async () => {
  stubFetch([{ body: ratings() }])
  render(<RadarPanel baseUrl={BASE} />)

  const thin = await screen.findByTestId('radar-model-gpt-5.6-sol-low')
  expect(thin).toHaveTextContent('9 票（少）')
  expect(thin).toHaveStyle({ opacity: '0.55' })

  const solid = screen.getByTestId('radar-model-gpt-5.6-luna-max')
  expect(solid).toHaveTextContent('215 票')
  expect(solid).not.toHaveTextContent('（少）')
  expect(solid).toHaveStyle({ opacity: '1' })
})

test('推荐只从样本足够的里挑 —— 不会把 9 票的冠军捧上去', async () => {
  stubFetch([{ body: ratings({ models: [
    { id: 'lucky', label: 'Lucky one', group: 'X', average: 10, count: 3 },
    { id: 'solid', label: 'Solid one', group: 'Y', average: 8.1, count: 120 },
  ] }) }])
  render(<RadarPanel baseUrl={BASE} />)

  const best = await screen.findByTestId('radar-best')
  expect(best).toHaveTextContent('Solid one')
  expect(best).not.toHaveTextContent('Lucky one')
})

test('刷新按钮带 force=1 直取上游', async () => {
  const calls = stubFetch([{ body: ratings() }])
  render(<RadarPanel baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('radar-refresh')).toBeEnabled())

  expect(calls[0]).not.toContain('force=1')
  await userEvent.click(screen.getByTestId('radar-refresh'))

  await waitFor(() => expect(calls).toHaveLength(2))
  expect(calls[1]).toContain('force=1')
})

test('走缓存时说明上游多久才更新一批 —— 免得以为刷新坏了', async () => {
  stubFetch([{ body: ratings({ cached: true }) }])
  render(<RadarPanel baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('radar-meta')).toHaveTextContent('5 分钟才更新一批'))
})

test('拿旧数据顶上时必须说清楚，而不是装作是最新的', async () => {
  stubFetch([{ body: ratings({
    cached: true, stale: true, error: '连不上 codexradar，检查网络或代理',
    fetchedAt: Date.now() - 42 * 60_000,
  }) }])
  render(<RadarPanel baseUrl={BASE} />)

  const banner = await screen.findByTestId('radar-stale')
  expect(banner).toHaveTextContent('没能连上 codexradar')
  expect(banner).toHaveTextContent('42 分钟前')
  // 旧数据仍然渲染出来 —— 比甩一张白纸强。
  expect(screen.getByTestId('radar-model-gpt-5.6-luna-max')).toBeInTheDocument()
})

test('彻底取不到时给人话原因，不显示空表', async () => {
  stubFetch([{ status: 502, body: { error: '连不上 codexradar，检查网络或代理', reasonCode: 'radar-unavailable' } }])
  render(<RadarPanel baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('radar-error')).toHaveTextContent('连不上 codexradar'))
  expect(screen.queryByTestId(/^radar-group-/)).not.toBeInTheDocument()
})

test('渲染的是自己的表，不是第三方 iframe', async () => {
  stubFetch([{ body: ratings() }])
  const { container } = render(<RadarPanel baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('radar-panel')).toBeInTheDocument())
  expect(container.querySelector('iframe')).toBeNull()
  expect(container.querySelector('script')).toBeNull()
})
