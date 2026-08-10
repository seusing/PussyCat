// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRadarService, DEFAULT_TTL_SECONDS, INSIGHTS_URL, MATRIX_URL, METRICS_URL } from './radar.mjs'

const INSIGHTS = {
  source_updated_at: '2026-08-05T07:05:35+00:00',
  recommendations: [{
    key: 'daily_development', title: '日常开发', rule: '原始 IQ ≥90…',
    items: [{
      model: 'gpt-5.6-sol', effort: 'xhigh', iq: 107.14,
      average_cost_usd: 6.461142, average_duration_minutes: 25.58,
    }],
  }],
}

const METRICS = {
  source_updated_at: '2026-08-05T07:19:31+00:00',
  runs_24h_total: 501,
  points: [{ model: 'gpt-5.6-sol', effort: 'xhigh', runs_24h: 13 }],
}

const MATRIX = {
  combos: [{ model: 'gpt-5.6-sol', effort: 'xhigh' }],
  tasks: [{ id: 't0' }, { id: 't1' }],
  cells: {
    't0|gpt-5.6-sol|xhigh': { ran_by: [{ passed: true, graded_at: '2026-08-01T00:00:00Z', actual_cost_usd: 6, duration_sec: 1500 }] },
    't1|gpt-5.6-sol|xhigh': { ran_by: [{ passed: false, graded_at: '2026-08-01T00:00:00Z', actual_cost_usd: 7, duration_sec: 1560 }] },
  },
  // 上游还塞了一堆用不上的东西,不该出现在回包里。
  online_volunteers: 11,
  token_pricing: { source: 'https://developers.example' },
}

function stubFetch({ fail = null } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    if (fail) throw fail
    const body = url === INSIGHTS_URL ? INSIGHTS : url === METRICS_URL ? METRICS : MATRIX
    return { ok: true, status: 200, json: async () => body }
  }
  return { impl, calls }
}

function tempStateFile() {
  const directory = mkdtempSync(join(tmpdir(), 'pussycat-radar-'))
  return { directory, stateFile: join(directory, 'node-state', 'radar-snapshot.json') }
}

describe('createRadarService', () => {
  it('一次取齐三个上游,算成推荐卡 + 模型格子', async () => {
    const { impl, calls } = stubFetch()
    const data = await createRadarService({ fetchImpl: impl }).get()

    expect(calls.map((c) => c.url).sort()).toEqual([MATRIX_URL, METRICS_URL, INSIGHTS_URL].sort())
    expect(data.picks[0].title).toBe('日常开发')
    expect(data.picks[0].items[0].label).toBe('Sol xhigh')
    expect(data.models[0]).toMatchObject({ label: 'Sol xhigh', iq: 75, runs24: 13 })
    expect(data.runs24hTotal).toBe(501)
    expect(data.taskCount).toBe(2)
    expect(data.updatedAt).toBe('2026-08-05T07:05:35+00:00')
  })

  it('只投影要显示的字段 —— 上游那 2.9MB 里的东西不该跟着进界面', async () => {
    const { impl } = stubFetch()
    const data = await createRadarService({ fetchImpl: impl }).get()

    expect(Object.keys(data).sort()).toEqual([
      'cached', 'fetchedAt', 'metricsUpdatedAt', 'models', 'picks',
      'runs24hTotal', 'stale', 'taskCount', 'ttlSeconds', 'updatedAt',
    ])
    expect(JSON.stringify(data)).not.toContain('online_volunteers')
    expect(JSON.stringify(data)).not.toContain('developers.example')
  })

  it('TTL 内走缓存 —— 那个矩阵接口 271KB,不该反复去拉', async () => {
    let clock = 1_000
    const { impl, calls } = stubFetch()
    const service = createRadarService({ fetchImpl: impl, now: () => clock })

    await service.get()
    expect(calls).toHaveLength(3)

    clock += (DEFAULT_TTL_SECONDS - 1) * 1000
    expect((await service.get()).cached).toBe(true)
    expect(calls).toHaveLength(3)

    clock += 2_000
    await service.get()
    expect(calls).toHaveLength(6)
  })

  it('默认 TTL 跟站方页面自己的节奏一致(10 分钟)', () => {
    expect(DEFAULT_TTL_SECONDS).toBe(600)
  })

  it('用户点刷新时直取上游 —— 否则那个按钮就是个摆设', async () => {
    const { impl, calls } = stubFetch()
    const service = createRadarService({ fetchImpl: impl, now: () => 1_000 })

    await service.get()
    await service.get({ force: true })

    expect(calls).toHaveLength(6)
  })

  it('上游挂了但手里有旧数据时给旧的并标 stale', async () => {
    let clock = 1_000
    let broken = false
    const { impl } = stubFetch()
    const service = createRadarService({
      fetchImpl: async (...args) => {
        if (broken) throw new Error('fetch failed')
        return impl(...args)
      },
      now: () => clock,
    })
    await service.get()

    broken = true
    clock += 999_000
    const stale = await service.get()

    expect(stale.stale).toBe(true)
    expect(stale.models).toHaveLength(1)
    expect(stale.error).toContain('连不上 codexradar')
    expect(stale.fetchedAt).toBe(1_000)      // 如实说这批是什么时候取的
  })

  it('第一次就挂且手上没有旧数据时如实抛,不假装空表', async () => {
    const { impl } = stubFetch({ fail: new Error('fetch failed') })

    await expect(createRadarService({ fetchImpl: impl }).get()).rejects.toThrow('fetch failed')
  })

  it('上游 5xx 如实抛,不当成一批空数据缓存起来', async () => {
    const impl = async () => ({ ok: false, status: 502, json: async () => ({}) })

    await expect(createRadarService({ fetchImpl: impl }).get()).rejects.toThrow('502')
  })

  it('矩阵是空的也算失败 —— 空表看着像"今天没人跑",会误导', async () => {
    const impl = async (url) => ({
      ok: true, status: 200,
      json: async () => (url === MATRIX_URL ? { combos: [], tasks: [], cells: {} }
        : url === METRICS_URL ? METRICS : INSIGHTS),
    })

    await expect(createRadarService({ fetchImpl: impl }).get()).rejects.toThrow('没有返回任何模型')
  })

  it('只发不带凭据的 GET —— 不往第三方送任何本机信息', async () => {
    const { impl, calls } = stubFetch()
    await createRadarService({ fetchImpl: impl }).get()

    for (const call of calls) {
      expect(call.url.startsWith('https://codexradar.com/api/')).toBe(true)
      expect(call.init.headers).toEqual({ Accept: 'application/json' })
      expect(call.init.body).toBeUndefined()
      expect(JSON.stringify(call.init)).not.toContain('ookie')
    }
  })

  it('recovers on the next refresh after an upstream failure', async () => {
    let clock = 1_000
    let broken = false
    const { impl } = stubFetch()
    const service = createRadarService({
      fetchImpl: async (...args) => {
        if (broken) throw new Error('fetch failed')
        return impl(...args)
      },
      now: () => clock,
    })

    await service.get()
    broken = true
    clock += (DEFAULT_TTL_SECONDS + 1) * 1000
    expect((await service.get()).stale).toBe(true)

    broken = false
    const recovered = await service.get({ force: true })
    expect(recovered.stale).toBe(false)
    expect(recovered.cached).toBe(false)
  })

  it('returns a stale persisted snapshot when a cold start cannot reach upstream', async () => {
    const { directory, stateFile } = tempStateFile()
    try {
      const first = createRadarService({ fetchImpl: stubFetch().impl, stateFile, now: () => 1_000 })
      await first.get()
      expect(JSON.parse(readFileSync(stateFile, 'utf8')).data.models).toHaveLength(1)

      const restarted = createRadarService({
        fetchImpl: async () => { throw new Error('fetch failed') },
        stateFile,
        now: () => 2_000,
      })
      const stale = await restarted.get()
      expect(stale.stale).toBe(true)
      expect(stale.models).toHaveLength(1)
      expect(stale.fetchedAt).toBe(1_000)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails soft on a corrupt persisted snapshot', async () => {
    const { directory, stateFile } = tempStateFile()
    try {
      const service = createRadarService({ fetchImpl: stubFetch().impl, stateFile })
      await service.get()
      writeFileSync(stateFile, '{not-json', 'utf8')
      const fresh = await createRadarService({ fetchImpl: stubFetch().impl, stateFile }).get()
      expect(fresh.stale).toBe(false)
      expect(fresh.models).toHaveLength(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('retains a safe endpoint and error diagnostics for a single upstream failure', async () => {
    let clock = 1_000
    let brokenUrl = null
    const matrixEndpoint = `${MATRIX_URL}?token=secret#fragment`
    const { impl } = stubFetch()
    const service = createRadarService({
      urls: { matrix: matrixEndpoint },
      fetchImpl: async (url, init) => {
        if (url === brokenUrl) {
          const error = new Error('proxy=https://user:secret@example.invalid')
          error.name = 'TypeError'
          error.code = 'ECONNRESET'
          error.cause = new Error('connect https://user:secret@example.invalid')
          throw error
        }
        return impl(url, init)
      },
      now: () => clock,
    })

    await service.get()
    brokenUrl = matrixEndpoint
    clock += (DEFAULT_TTL_SECONDS + 1) * 1000
    const stale = await service.get()
    expect(stale.diagnostic).toMatchObject({
      endpoint: MATRIX_URL,
      error: { name: 'TypeError', code: 'ECONNRESET', cause: { name: 'Error' } },
    })
    expect(JSON.stringify(stale)).not.toContain('secret')
  })
})
