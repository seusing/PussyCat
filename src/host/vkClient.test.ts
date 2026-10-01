import { HostRequestError } from './errors'
import {
  clearVkJevConfig, classifyVkIntent, fetchVkJobs, fetchVkOutputText, fetchVkStoryline, fetchVkStorylines,
  postVkJob, postVkStoryline, saveVkJevConfig, vkOutputPath,
} from './vkClient'

function stubFetch(status: number, body: unknown) {
  const impl = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => String(body),
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

  it('fetches an escaped output path and returns its text body', async () => {
    const markdown = '# 测试笔记\n\n正文 **加粗**'
    const impl = stubFetch(200, markdown)

    await expect(fetchVkOutputText('notes/a.md', 'http://127.0.0.1:9999')).resolves.toBe(markdown)
    expect(impl).toHaveBeenCalledWith('http://127.0.0.1:9999/vk/v1/outputs/notes%2Fa.md')
  })

  it('classifies only the bounded user goal through the Host proxy', async () => {
    const impl = stubFetch(200, { classified: true, classification: { intent_id: 'quick_overview', confidence: 0.9 } })
    await classifyVkIntent('重点'.repeat(600), 'http://127.0.0.1:9999')
    expect(impl.mock.calls[0][0]).toBe('http://127.0.0.1:9999/vk/v1/intent-classify')
    expect(JSON.parse(String(impl.mock.calls[0][1]?.body)).user_goal).toHaveLength(1000)
  })

  it('saves and clears Jev credentials without requesting a reveal', async () => {
    const impl = stubFetch(200, { saved: true, configured: false })
    await saveVkJevConfig('jev-secret', 'http://127.0.0.1:9999')
    await clearVkJevConfig('http://127.0.0.1:9999')
    expect(impl.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:9999/vk/v1/jev/config',
      'http://127.0.0.1:9999/vk/v1/jev/config/clear',
    ])
    expect(impl.mock.calls.some(([url]) => String(url).includes('reveal'))).toBe(false)
  })

  it('posts the batch id to start a storyline and returns the id and status', async () => {
    const impl = stubFetch(201, { storyline_id: 'sl_1', status: 'queued' })
    await expect(postVkStoryline('batch-1', 'http://127.0.0.1:9999')).resolves.toEqual({ storyline_id: 'sl_1', status: 'queued' })
    expect(impl.mock.calls[0][0]).toBe('http://127.0.0.1:9999/vk/v1/storylines')
    expect(impl.mock.calls[0][1]?.method).toBe('POST')
    expect(JSON.parse(String(impl.mock.calls[0][1]?.body))).toEqual({ batch_id: 'batch-1' })
  })

  it('lists storylines for one batch with an escaped query, or all of them without one', async () => {
    const impl = stubFetch(200, [])
    await fetchVkStorylines('a b/1', 'http://127.0.0.1:9999')
    await fetchVkStorylines(undefined, 'http://127.0.0.1:9999')
    expect(impl.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:9999/vk/v1/storylines?batch_id=a%20b%2F1',
      'http://127.0.0.1:9999/vk/v1/storylines',
    ])
    expect(impl.mock.calls[0][1]?.method).toBeUndefined()
  })

  it('reads one storyline with its result', async () => {
    const view = { storyline_id: 'sl 1', status: 'done', result: { storylines: [] } }
    const impl = stubFetch(200, view)
    await expect(fetchVkStoryline('sl 1', 'http://127.0.0.1:9999')).resolves.toEqual(view)
    expect(impl.mock.calls[0][0]).toBe('http://127.0.0.1:9999/vk/v1/storylines/sl%201')
  })

  it('surfaces a 404 from an engine without storylines as a HostRequestError with that status', async () => {
    stubFetch(404, { error: 'not found' })
    for (const call of [
      () => fetchVkStorylines('b', 'http://127.0.0.1:9999'),
      () => fetchVkStoryline('sl_1', 'http://127.0.0.1:9999'),
      () => postVkStoryline('b', 'http://127.0.0.1:9999'),
    ]) {
      const error = await call().catch((err) => err)
      expect(error).toBeInstanceOf(HostRequestError)
      expect(error.status).toBe(404)
    }
  })
})
