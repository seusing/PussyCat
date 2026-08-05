// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch as realFetch } from 'undici'
import { loadExecutionPolicy } from './policy.mjs'
import { createHostServer } from './host-server.mjs'
import { createVkJobShadow } from './vk-job-shadow.mjs'
import { createRadarService, INSIGHTS_URL, MATRIX_URL, METRICS_URL } from './radar.mjs'

const ORIGIN = 'http://127.0.0.1:5173'
const openApps = new Set()

beforeEach(() => {
  vi.stubGlobal('fetch', realFetch)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const app of openApps) {
    await app.close()
    openApps.delete(app)
  }
})

class FakeVkSidecar {
  constructor() {
    this.requests = []
    this.stopped = false
    this.responses = new Map()
  }

  respond(key, payload, { status = 200, contentType = 'application/json; charset=utf-8' } = {}) {
    this.responses.set(key, { payload, status, contentType })
  }

  async ensureStarted() {
    return { ok: true }
  }

  async fetchApi(path, init = {}) {
    this.requests.push({ path, init })
    const key = `${init.method ?? 'GET'} ${path}`
    const canned = this.responses.get(key) ?? { payload: { echo: key }, status: 200, contentType: 'application/json; charset=utf-8' }
    const body = typeof canned.payload === 'string' || Buffer.isBuffer(canned.payload)
      ? Buffer.from(canned.payload)
      : Buffer.from(JSON.stringify(canned.payload))
    return {
      ok: canned.status < 400,
      status: canned.status,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? canned.contentType : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    }
  }

  health() {
    return {
      status: 'ok',
      reasonCode: 'ok',
      summary: 'sidecar 就绪',
      apiVersion: '1.1.0',
      packageVersion: '0.1.0',
      capabilities: [],
      checkedAt: '2026-08-01T00:00:00.000Z',
      retryable: false,
    }
  }

  async stop() {
    this.stopped = true
  }
}

async function setup({ vkSidecar = new FakeVkSidecar(), vkJobShadow = createVkJobShadow({}), radarService = undefined } = {}) {
  const policy = loadExecutionPolicy('public/catalog.snapshot.json')
  const app = createHostServer({
    opencliEntry: 'C:\\fixture\\opencli\\main.js',
    policy,
    vkSidecar,
    vkJobShadow,
    ...(radarService ? { radarService } : {}),
  })
  const address = await app.listen({ port: 0 })
  openApps.add(app)
  const baseUrl = `http://127.0.0.1:${address.port}`
  return { app, baseUrl, vkSidecar, vkJobShadow }
}

function jsonHeaders(extra = {}) {
  return { Origin: ORIGIN, 'Content-Type': 'application/json', ...extra }
}

describe('/vk/v1 proxy', () => {
  it('proxies GET meta through the whitelist and stays behind the Origin gate', async () => {
    const { baseUrl, vkSidecar } = await setup()
    vkSidecar.respond('GET /api/meta', { service: 'video-knowledge', api_version: '1.1.0' })

    const denied = await fetch(`${baseUrl}/vk/v1/meta`)
    expect(denied.status).toBe(403)

    const allowed = await fetch(`${baseUrl}/vk/v1/meta`, { headers: { Origin: ORIGIN } })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({ service: 'video-knowledge' })
    expect(vkSidecar.requests[0].path).toBe('/api/meta')
  })

  it('rejects non-whitelisted vk paths without forwarding', async () => {
    const { baseUrl, vkSidecar } = await setup()
    const response = await fetch(`${baseUrl}/vk/v1/secret`, { headers: { Origin: ORIGIN } })
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.reasonCode).toBe('vk-route-not-allowed')
    expect(vkSidecar.requests).toHaveLength(0)
  })

  it('returns the typed sidecar diagnostic as 503 when the sidecar is unavailable', async () => {
    const vkSidecar = new FakeVkSidecar()
    vkSidecar.ensureStarted = async () => {
      const { VkSidecarError } = await import('./vk-sidecar.mjs')
      throw new VkSidecarError(503, 'video-knowledge runtime 未配置', {
        reasonCode: 'not-configured',
      })
    }
    const { baseUrl } = await setup({ vkSidecar })
    const response = await fetch(`${baseUrl}/vk/v1/jobs`, { headers: { Origin: ORIGIN } })
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.reasonCode).toBe('not-configured')
  })

  it('serves /vk/v1/health as a Node-side projection without forwarding', async () => {
    const { baseUrl, vkSidecar } = await setup()
    const response = await fetch(`${baseUrl}/vk/v1/health`, { headers: { Origin: ORIGIN } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', apiVersion: '1.1.0' })
    expect(vkSidecar.requests).toHaveLength(0)
  })

  it('strips client_job_id before forwarding job submissions and records a sanitized shadow entry', async () => {
    const vkJobShadow = createVkJobShadow({})
    const { baseUrl, vkSidecar } = await setup({ vkJobShadow })
    vkSidecar.respond('POST /api/jobs', { job_id: 'job-77', kind: 'request' }, { status: 201 })

    const response = await fetch(`${baseUrl}/vk/v1/jobs`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        request: { source: 'https://example.com/v?xsec_token=zz', preset: 'quick-summary' },
        idempotency_key: 'idem-9',
        client_job_id: 'client-9',
      }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ job_id: 'job-77', kind: 'request' })

    const forwarded = JSON.parse(vkSidecar.requests[0].init.body)
    expect(forwarded.client_job_id).toBeUndefined()
    expect(forwarded.idempotency_key).toBe('idem-9')

    const entries = vkJobShadow.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ clientJobId: 'client-9', idempotencyKey: 'idem-9' })
    expect(JSON.stringify(entries)).not.toContain('example.com')
  })

  it('taps job views to update the shadow with run_id/fingerprint/status and passes the body through unchanged', async () => {
    const vkJobShadow = createVkJobShadow({})
    const { baseUrl, vkSidecar } = await setup({ vkJobShadow })
    vkSidecar.respond('POST /api/jobs', { job_id: 'job-1', kind: 'request' }, { status: 201 })
    const view = {
      job_id: 'job-1',
      status: 'done',
      run_id: 'run-42',
      request_fingerprint: 'a'.repeat(64),
      request: { source: 'https://example.com/v' },
      outputs: { note_path: 'out_9' },
    }
    vkSidecar.respond('GET /api/jobs/job-1', view)

    await fetch(`${baseUrl}/vk/v1/jobs`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ request: { preset: 'quick-summary' }, client_job_id: 'c-1' }),
    })
    const got = await fetch(`${baseUrl}/vk/v1/jobs/job-1`, { headers: { Origin: ORIGIN } })
    expect(await got.json()).toEqual(view)

    const entry = vkJobShadow.list()[0]
    expect(entry.runId).toBe('run-42')
    expect(entry.requestFingerprint).toBe('a'.repeat(64))
    expect(entry.displayStatus).toBe('done')
  })

  it('forwards binary uploads with the name query and content type, bypassing the JSON body limit', async () => {
    const { baseUrl, vkSidecar } = await setup()
    vkSidecar.respond('POST /api/uploads?name=a.srt', { upload_id: 'up_1', is_manifest: false, bytes: 5 }, { status: 201 })

    const payload = Buffer.alloc(70 * 1024, 1) // 大于 host 的 64KiB JSON 上限
    const response = await fetch(`${baseUrl}/vk/v1/uploads?name=a.srt`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/octet-stream' },
      body: payload,
    })
    expect(response.status).toBe(201)
    const forwarded = vkSidecar.requests[0]
    expect(forwarded.path).toBe('/api/uploads?name=a.srt')
    expect(forwarded.init.headers['Content-Type']).toBe('application/octet-stream')
    expect(forwarded.init.body.length).toBe(payload.length)
  })

  it('sentinel: raw URL rides only the execution channel — shadow and Node state stay clean', async () => {
    const SENTINEL = 'SENTINELxsec0123456789'
    const vkJobShadow = createVkJobShadow({})
    const { baseUrl, vkSidecar } = await setup({ vkJobShadow })
    vkSidecar.respond('POST /api/jobs', { job_id: 'job-s', kind: 'request' }, { status: 201 })

    const response = await fetch(`${baseUrl}/vk/v1/jobs`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        source: `https://www.xiaohongshu.com/item/x?xsec_token=${SENTINEL}`,
        preset: 'quick-summary',
        idempotency_key: 'idem-s',
        client_job_id: 'client-s',
      }),
    })
    expect(response.status).toBe(201)
    // 执行通道:转发体携带原始 URL(vk 端只让它进执行对象)
    const forwarded = JSON.parse(vkSidecar.requests[0].init.body)
    expect(forwarded.source).toContain(SENTINEL)
    expect(forwarded.client_job_id).toBeUndefined()
    // Node 持久面零哨兵:影子结构性不存 URL
    expect(JSON.stringify(vkJobShadow.list())).not.toContain(SENTINEL)
    expect(JSON.stringify(vkJobShadow.list())).not.toContain('xiaohongshu')
  })

  it('tears the sidecar down on close()', async () => {
    const { app, vkSidecar } = await setup()
    await app.close()
    openApps.delete(app)
    expect(vkSidecar.stopped).toBe(true)
  })

  it('转发模型通道四条路由，且请求体不进 job shadow —— 里面带着 API key', async () => {
    const vkJobShadow = createVkJobShadow({})
    const { baseUrl, vkSidecar } = await setup({ vkJobShadow })
    const KEY = 'sk-relay-DO-NOT-LEAK-0123456789'
    vkSidecar.respond('POST /api/providers/cc-switch', {
      channel: { id: 'hhcoding-sol', api_style: 'openai_responses' },
      api_key: KEY,
      notes: [],
    })

    const response = await fetch(`${baseUrl}/vk/v1/providers/cc-switch`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: 'codex:242d3850', taken_ids: [] }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ api_key: KEY })
    expect(vkSidecar.requests.at(-1).path).toBe('/api/providers/cc-switch')
    // I-P7：影子只留五个字段。这条路径的请求体与回包都带 key，连投影都不做。
    expect(JSON.stringify(vkJobShadow.list())).not.toContain(KEY)
    expect(vkJobShadow.list()).toHaveLength(0)
  })

  it('其余三条通道路由也在白名单里', async () => {
    const { baseUrl, vkSidecar } = await setup()
    const cases = [
      ['GET', '/vk/v1/providers', '/api/providers'],
      ['POST', '/vk/v1/providers/test', '/api/providers/test'],
      ['POST', '/vk/v1/providers/reveal', '/api/providers/reveal'],
    ]
    for (const [method, from, to] of cases) {
      const response = await fetch(`${baseUrl}${from}`, {
        method,
        headers: jsonHeaders(),
        ...(method === 'POST' ? { body: '{}' } : {}),
      })
      expect(response.status, `${method} ${from}`).toBe(200)
      expect(vkSidecar.requests.at(-1).path).toBe(to)
    }
  })

  it('codexradar 走 Node 侧代取 —— 渲染进程不直连第三方,CSP 不必为这几张表开口子', async () => {
    const BODIES = {
      [INSIGHTS_URL]: {
        source_updated_at: '2026-08-05T07:05:35+00:00',
        recommendations: [{ key: 'daily_development', title: '日常开发', rule: 'r', items: [
          { model: 'gpt-5.6-sol', effort: 'xhigh', iq: 107.14, average_cost_usd: 6.46, average_duration_minutes: 25.58 },
        ] }],
      },
      [METRICS_URL]: {
        source_updated_at: '2026-08-05T07:19:31+00:00', runs_24h_total: 501,
        points: [{ model: 'gpt-5.6-sol', effort: 'xhigh', runs_24h: 13 }],
      },
      [MATRIX_URL]: {
        combos: [{ model: 'gpt-5.6-sol', effort: 'xhigh' }],
        tasks: [{ id: 't0' }],
        cells: { 't0|gpt-5.6-sol|xhigh': { ran_by: [
          { passed: true, graded_at: '2026-08-01T00:00:00Z', actual_cost_usd: 6.46, duration_sec: 1535 },
        ] } },
        online_volunteers: 11,
      },
    }
    const upstream = []
    const radarService = createRadarService({
      fetchImpl: async (url, init) => {
        upstream.push({ url, init })
        return { ok: true, status: 200, json: async () => BODIES[url] }
      },
    })
    const { baseUrl } = await setup({ radarService })

    const denied = await fetch(`${baseUrl}/radar/v1/model-ratings`)
    expect(denied.status).toBe(403)

    const allowed = await fetch(`${baseUrl}/radar/v1/model-ratings`, { headers: { Origin: ORIGIN } })
    expect(allowed.status).toBe(200)
    const body = await allowed.json()
    expect(body.models).toHaveLength(1)
    expect(body.picks[0].title).toBe('日常开发')
    expect(body.cached).toBe(false)
    // 只投影要渲染的字段,上游那 2.9MB 里的杂项进不了界面。
    expect(JSON.stringify(body)).not.toContain('online_volunteers')
    expect(upstream).toHaveLength(3)

    // 第二次走缓存,force=1 才直取上游。
    await fetch(`${baseUrl}/radar/v1/model-ratings`, { headers: { Origin: ORIGIN } })
    expect(upstream).toHaveLength(3)
    await fetch(`${baseUrl}/radar/v1/model-ratings?force=1`, { headers: { Origin: ORIGIN } })
    expect(upstream).toHaveLength(6)
  })

  it('codexradar 挂了且没有旧数据时给 502 与人话原因', async () => {
    const radarService = createRadarService({
      fetchImpl: async () => { throw new Error('fetch failed') },
    })
    const { baseUrl } = await setup({ radarService })

    const response = await fetch(`${baseUrl}/radar/v1/model-ratings`, { headers: { Origin: ORIGIN } })

    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.reasonCode).toBe('radar-unavailable')
    expect(body.error).toContain('连不上 codexradar')
  })
})
