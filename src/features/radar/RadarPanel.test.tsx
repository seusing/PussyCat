import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RadarPanel } from './RadarPanel'

const BASE = 'http://127.0.0.1:9999'

function model(over: Record<string, unknown> = {}) {
  return {
    id: 'gpt-5.6-sol|xhigh', model: 'gpt-5.6-sol', effort: 'xhigh', family: 'Sol',
    color: '#e3a008', label: 'Sol xhigh', iq: 107.1, passed: 80, samples: 112,
    costUsd: 6.461142, minutes: 25.58, runs24: 13, cci: 12.3,
    ...over,
  }
}

function ratings(over: Record<string, unknown> = {}) {
  return {
    picks: [{
      key: 'daily_development', title: '日常开发', rule: '原始 IQ ≥90，不再分档…',
      items: [
        { id: 'gpt-5.6-sol|xhigh', label: 'Sol xhigh', color: '#e3a008', iq: 107.14, costUsd: 6.461142, minutes: 25.58 },
        { id: 'gpt-5.6-luna|max', label: 'Luna max', color: '#c9d1d9', iq: 96.43, costUsd: 0.4641, minutes: 31.26 },
      ],
    }],
    models: [
      model({ id: 'sol|ultra', effort: 'ultra', label: 'Sol ultra', iq: 103.1, costUsd: 22.04, minutes: 51, runs24: 24, cci: 100 }),
      model(),
      model({ id: 'luna|max', model: 'gpt-5.6-luna', effort: 'max', family: 'Luna', color: '#c9d1d9', label: 'Luna max', iq: 96.4, costUsd: 0.4641, minutes: 31.26, runs24: 42, cci: 1.5 }),
      model({ id: 'luna|low', model: 'gpt-5.6-luna', effort: 'low', family: 'Luna', color: '#c9d1d9', label: 'Luna low', iq: 12.1, costUsd: 0.03, minutes: 5, runs24: 19, cci: 0.0001 }),
    ],
    updatedAt: '2026-08-05T07:11:00.000Z',
    metricsUpdatedAt: '2026-08-05T07:19:00.000Z',
    runs24hTotal: 502,
    taskCount: 112,
    cached: false, stale: false, ttlSeconds: 600, fetchedAt: Date.now(),
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

// ── 电台精选 ────────────────────────────────────────────────────────────

test('推荐卡按站方的四类给出，每条带 IQ / 费用 / 耗时', async () => {
  stubFetch([{ body: ratings() }])
  render(<RadarPanel baseUrl={BASE} />)

  const card = await screen.findByTestId('radar-pick-daily_development')
  expect(card).toHaveTextContent('日常开发')
  expect(card).toHaveTextContent('Sol xhigh')
  expect(card).toHaveTextContent('107.1')
  expect(card).toHaveTextContent('$6.46')
  expect(card).toHaveTextContent('26m')
  expect(card).toHaveTextContent('Luna max')
})

test('挑选规则挂在标题上 —— 不说清楚，推荐就是个黑箱', async () => {
  stubFetch([{ body: ratings() }])
  render(<RadarPanel baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('radar-pick-daily_development')).toBeInTheDocument())
  const title = within(screen.getByTestId('radar-pick-daily_development')).getByTitle(/原始 IQ ≥90/)
  expect(title).toBeInTheDocument()
})

// ── 智能效率 ────────────────────────────────────────────────────────────

test('每格给 IQ、费用、耗时和 24 小时运行次数', async () => {
  stubFetch([{ body: ratings() }])
  render(<RadarPanel baseUrl={BASE} />)

  const cell = await screen.findByTestId('radar-model-sol|ultra')
  expect(cell).toHaveTextContent('Sol ultra')
  expect(cell).toHaveTextContent('103.1')
  expect(cell).toHaveTextContent('$22.04')
  expect(cell).toHaveTextContent('51m')
  // 次数是这个数字的分量所在,不能省。
  expect(cell).toHaveTextContent('24')
})

test('截断的模型名接入 OverflowTooltip', async () => {
  stubFetch([{ body: ratings() }])
  render(<RadarPanel baseUrl={BASE} />)

  const cell = await screen.findByTestId('radar-model-sol|ultra')
  expect(cell.querySelector('.overflow-tooltip__label')).toHaveTextContent('Sol ultra')
})

test('同一档位对齐到同一列 —— 横着看才比得了', async () => {
  stubFetch([{ body: ratings() }])
  render(<RadarPanel baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('radar-family-Sol')).toBeInTheDocument())
  // TIERS = ultra,max,xhigh,high,medium,low → ultra 占第 1 列、xhigh 第 3 列
  expect(screen.getByTestId('radar-model-sol|ultra').parentElement).toHaveStyle({ gridColumn: '1' })
  expect(screen.getByTestId('radar-model-gpt-5.6-sol|xhigh').parentElement).toHaveStyle({ gridColumn: '3' })
  // Luna 没有 ultra,它的 max 仍然落在第 2 列而不是挤到最左
  expect(screen.getByTestId('radar-model-luna|max').parentElement).toHaveStyle({ gridColumn: '2' })
})

test('24 小时有效运行总数单独标出来', async () => {
  stubFetch([{ body: ratings() }])
  render(<RadarPanel baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('radar-runs')).toHaveTextContent('502 次有效运行'))
})

test('两处刷新按钮都在，且都直取上游', async () => {
  const calls = stubFetch([{ body: ratings() }])
  render(<RadarPanel baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('radar-refresh-picks')).toBeEnabled())

  expect(calls[0]).not.toContain('force=1')
  await userEvent.click(screen.getByTestId('radar-refresh-picks'))
  await waitFor(() => expect(calls).toHaveLength(2))
  expect(calls[1]).toContain('force=1')

  await userEvent.click(screen.getByTestId('radar-refresh-efficiency'))
  await waitFor(() => expect(calls).toHaveLength(3))
  expect(calls[2]).toContain('force=1')
})

// ── 成本 × IQ 图 ────────────────────────────────────────────────────────

test('画的是自己的 SVG，不是第三方 iframe', async () => {
  stubFetch([{ body: ratings() }])
  const { container } = render(<RadarPanel baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('radar-chart')).toBeInTheDocument())
  expect(container.querySelector('svg')).not.toBeNull()
  expect(container.querySelector('iframe')).toBeNull()
  expect(container.querySelector('script')).toBeNull()
})

test('每个家族一条折线，点上能看到那一格的四个数', async () => {
  stubFetch([{ body: ratings() }])
  const { container } = render(<RadarPanel baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('radar-chart')).toBeInTheDocument())
  expect(container.querySelectorAll('polyline')).toHaveLength(2)      // Sol / Luna
  const titles = [...container.querySelectorAll('svg title')].map((t) => t.textContent)
  expect(titles).toContain('Sol ultra · IQ 103.1 · $22.04 · 51m')
})

test('缺相对成本的格子不画进图里 —— 不硬凑一个 0 放在最左边', async () => {
  stubFetch([{ body: ratings({ models: [
    model({ id: 'a', cci: 50 }), model({ id: 'b', cci: null, costUsd: null }), model({ id: 'c', cci: 1 }),
  ] }) }])
  const { container } = render(<RadarPanel baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('radar-chart')).toBeInTheDocument())
  expect(container.querySelectorAll('svg circle')).toHaveLength(2)
  // 但它仍然出现在格子表里,只是费用一栏显示 —
  expect(screen.getByTestId('radar-model-b')).toHaveTextContent('—')
})

// ── 失败与降级 ──────────────────────────────────────────────────────────

test('拿旧数据顶上时必须说清楚，而不是装作是最新的', async () => {
  stubFetch([{ body: ratings({
    cached: true, stale: true, error: '连不上 codexradar，检查网络或代理',
    fetchedAt: Date.parse('2026-08-05T06:00:00.000Z'),
  }) }])
  render(<RadarPanel baseUrl={BASE} />)

  const banner = await screen.findByTestId('radar-stale')
  expect(banner).toHaveTextContent('没能连上 codexradar')
  // 旧数据仍然渲染 —— 比甩一张白纸强。
  expect(screen.getByTestId('radar-model-sol|ultra')).toBeInTheDocument()
})

test('彻底取不到时给人话原因，不显示空表', async () => {
  stubFetch([{ status: 502, body: { error: '连不上 codexradar，检查网络或代理', reasonCode: 'radar-unavailable' } }])
  render(<RadarPanel baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('radar-error')).toHaveTextContent('连不上 codexradar'))
  expect(screen.queryByTestId('radar-chart')).not.toBeInTheDocument()
})
