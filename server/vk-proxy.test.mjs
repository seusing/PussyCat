// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch as realFetch } from 'undici'
import { loadExecutionPolicy } from './policy.mjs'
import { createHostServer } from './host-server.mjs'
import { createVkJobShadow } from './vk-job-shadow.mjs'

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

async function setup({ vkSidecar = new FakeVkSidecar(), vkJobShadow = createVkJobShadow({}) } = {}) {
  const policy = loadExecutionPolicy('public/catalog.snapshot.json')
  const app = createHostServer({
    opencliEntry: 'C:\\fixture\\opencli\\main.js',
    policy,
    vkSidecar,
    vkJobShadow,
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

  it('tears the sidecar down on close()', async () => {
    const { app, vkSidecar } = await setup()
    await app.close()
    openApps.delete(app)
    expect(vkSidecar.stopped).toBe(true)
  })
})
