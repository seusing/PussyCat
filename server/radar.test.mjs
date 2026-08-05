// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createRadarService, projectRatings, ttlFrom, MIN_TTL_SECONDS } from './radar.mjs'

const RAW = {
  ok: true,
  day: '2026-08-05',
  timezone: 'Asia/Shanghai',
  refresh_seconds: 300,
  updated_at: '2026-08-05T06:45:12.174Z',
  window: 'rolling_24h',
  window_hours: 24,
  source: 'public_cache',
  models: [
    { id: 'gpt-5.6-luna-max', label: 'GPT-5.6 Luna max', group: 'GPT-5.6 Luna', average: 8.8, count: 215 },
    { id: 'gpt-5.6-sol-low', label: 'GPT-5.6 Sol low', group: 'GPT-5.6 Sol', average: 4.7, count: 9 },
  ],
}

function stubFetch(sequence) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const next = sequence[Math.min(calls.length - 1, sequence.length - 1)]
    if (typeof next === 'function') return next()
    return { ok: true, status: 200, json: async () => next }
  }
  return { impl, calls }
}

describe('projectRatings', () => {
  it('只投影要渲染的字段 —— my_scores 那类跟登录用户绑定的东西进不来', () => {
    const data = projectRatings({ ...RAW, my_scores: { 'gpt-5.6-sol': 9 }, my_score_records: { a: 1 } })

    expect(Object.keys(data).sort()).toEqual(
      ['day', 'models', 'source', 'timezone', 'updatedAt', 'window', 'windowHours'],
    )
    expect(JSON.stringify(data)).not.toContain('my_score')
  })

  it('每条只留 id/label/group/average/count', () => {
    const data = projectRatings({
      models: [{ id: 'x', label: 'X', group: 'G', average: 7, count: 3, note: '<script>' }],
    })
    expect(data.models[0]).toEqual({ id: 'x', label: 'X', group: 'G', average: 7, count: 3 })
  })

  it('缺字段不炸,给得出的都给', () => {
    const data = projectRatings({ models: [{ id: 'x' }, { label: '没有 id' }, null] })
    expect(data.models).toEqual([{ id: 'x', label: 'x', group: '其他', average: null, count: 0 }])
    expect(data.updatedAt).toBe('')
  })

  it('上游整个不是那个形状时给空表而不是抛', () => {
    expect(projectRatings(null).models).toEqual([])
    expect(projectRatings({ models: 'nope' }).models).toEqual([])
  })
})

describe('ttlFrom', () => {
  it('用上游自己报的 refresh_seconds', () => {
    expect(ttlFrom({ refresh_seconds: 300 })).toBe(300)
  })

  it('上游报了个极小值也有下限 —— 别把人家打爆', () => {
    expect(ttlFrom({ refresh_seconds: 1 })).toBe(MIN_TTL_SECONDS)
  })

  it('没报或报了垃圾时回落到默认', () => {
    expect(ttlFrom({})).toBe(300)
    expect(ttlFrom({ refresh_seconds: 'soon' })).toBe(300)
  })
})

describe('createRadarService', () => {
  it('TTL 内的自动请求走缓存 —— 上游 5 分钟才更新一批,问得再勤也是同样的字节', async () => {
    let clock = 1_000
    const { impl, calls } = stubFetch([RAW])
    const service = createRadarService({ fetchImpl: impl, now: () => clock })

    const first = await service.get()
    expect(first.cached).toBe(false)
    expect(first.models).toHaveLength(2)

    clock += 299_000
    const second = await service.get()
    expect(second.cached).toBe(true)
    expect(calls).toHaveLength(1)

    clock += 2_000            // 过了 301 秒
    await service.get()
    expect(calls).toHaveLength(2)
  })

  it('用户点刷新时直取上游 —— 否则那个按钮就是个摆设', async () => {
    let clock = 1_000
    const { impl, calls } = stubFetch([RAW])
    const service = createRadarService({ fetchImpl: impl, now: () => clock })

    await service.get()
    await service.get({ force: true })

    expect(calls).toHaveLength(2)
  })

  it('上游挂了但手里有旧数据时给旧的并标 stale —— 比甩一张白纸强', async () => {
    let clock = 1_000
    const { impl } = stubFetch([
      RAW,
      () => { throw new Error('fetch failed') },
    ])
    const service = createRadarService({ fetchImpl: impl, now: () => clock })
    await service.get()

    clock += 400_000
    const stale = await service.get()

    expect(stale.stale).toBe(true)
    expect(stale.models).toHaveLength(2)
    expect(stale.error).toContain('连不上 codexradar')
    expect(stale.fetchedAt).toBe(1_000)      // 如实说这批数据是什么时候的
  })

  it('第一次就挂且手上没有旧数据时如实抛,不假装空表', async () => {
    const { impl } = stubFetch([() => { throw new Error('fetch failed') }])
    const service = createRadarService({ fetchImpl: impl })

    await expect(service.get()).rejects.toThrow('fetch failed')
  })

  it('上游 5xx 如实抛,不当成一批空数据缓存起来', async () => {
    const { impl } = stubFetch([() => ({ ok: false, status: 502, json: async () => ({}) })])
    const service = createRadarService({ fetchImpl: impl })

    await expect(service.get()).rejects.toThrow('502')
  })

  it('上游回了个空模型表也算失败 —— 空表看起来像"今天没人评分",会误导', async () => {
    const { impl } = stubFetch([{ ...RAW, models: [] }])
    const service = createRadarService({ fetchImpl: impl })

    await expect(service.get()).rejects.toThrow('没有返回任何模型')
  })

  it('只发不带凭据的 GET —— 不往第三方送任何本机信息', async () => {
    const { impl, calls } = stubFetch([RAW])
    const service = createRadarService({ fetchImpl: impl })

    await service.get()

    expect(calls[0].url).toBe('https://codexradar.com/api/model-ratings')
    expect(calls[0].init.headers).toEqual({ Accept: 'application/json' })
    expect(calls[0].init.body).toBeUndefined()
    expect(JSON.stringify(calls[0].init)).not.toContain('ookie')
  })
})
