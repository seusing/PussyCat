import { HostRequestError } from './errors'
import { fetchVkJobs, postVkJob, vkOutputPath } from './vkClient'

function stubFetch(status: number, body: unknown) {
  const impl = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status < 400,
    status,
    json: async () => body,
  }))
  vi.stubGlobal('fetch', impl)
  return impl
}

describe('vkClient', () => {
  it('posts the submit payload as JSON to the proxy', async () => {
    const impl = stubFetch(201, { job_id: 'j1', kind: 'request' })
    const payload = {
      request: { preset: 'quick-summary' } as never,
      idempotency_key: 'k',
      client_job_id: 'c',
    }
    const created = await postVkJob(payload, 'http://127.0.0.1:9999')
    expect(created.job_id).toBe('j1')
    expect(impl.mock.calls[0][0]).toBe('http://127.0.0.1:9999/vk/v1/jobs')
    expect(impl.mock.calls[0][1]?.method).toBe('POST')
    expect(JSON.parse(String(impl.mock.calls[0][1]?.body))).toMatchObject({ idempotency_key: 'k', client_job_id: 'c' })
  })

  it('maps proxy errors to HostRequestError with the wire reasonCode', async () => {
    stubFetch(503, { error: 'video-knowledge sidecar 未接线', reasonCode: 'not-configured' })
    const error = await fetchVkJobs('http://127.0.0.1:9999').catch((err) => err)
    expect(error).toBeInstanceOf(HostRequestError)
    expect(error.status).toBe(503)
    expect(error.reasonCode).toBe('not-configured')
    expect(error.summary).toContain('未接线')
  })

  it('escapes output ids in the download path', () => {
    expect(vkOutputPath('out_abc')).toBe('/vk/v1/outputs/out_abc')
    expect(vkOutputPath('a/b')).toBe('/vk/v1/outputs/a%2Fb')
  })
})
