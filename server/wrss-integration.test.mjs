// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWrssIntegration, WrssIntegrationError } from './wrss-integration.mjs'

const dirs = []
afterEach(() => {
  vi.restoreAllMocks()
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

function stateFile() {
  const root = mkdtempSync(join(tmpdir(), 'wrss-state-'))
  dirs.push(root)
  return join(root, 'wrss.json')
}

describe('WeRSS integration', () => {
  it('defaults to local 8001 but remains explicitly unconfigured', () => {
    const integration = createWrssIntegration()
    expect(integration.status()).toMatchObject({
      configured: false,
      base_url: 'http://127.0.0.1:8001',
      state: 'not-configured',
      protocol_verified: false,
    })
  })

  it.each([
    'https://example.com',
    'http://169.254.169.254/latest/meta-data',
    'file:///C:/secret',
    'http://user:pass@127.0.0.1:8001',
    'http://127.0.0.1:8001/#fragment',
  ])('rejects non-loopback or credential-bearing URL: %s', (url) => {
    const integration = createWrssIntegration()
    expect(() => integration.save(url)).toThrowError(WrssIntegrationError)
  })

  it('persists only the normalized local URL', () => {
    const file = stateFile()
    const integration = createWrssIntegration({ stateFile: file })
    integration.save('http://localhost:8001/')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      schema: 'wrss-integration@1',
      baseUrl: 'http://localhost:8001',
    })
    expect(createWrssIntegration({ stateFile: file }).status()).toMatchObject({
      configured: true,
      state: 'saved',
    })
  })

  it('tests reachability without following redirects or reading a response body', async () => {
    const cancel = vi.fn()
    const fetchImpl = vi.fn(async () => ({ status: 302, body: { cancel } }))
    const integration = createWrssIntegration({ fetchImpl })
    integration.save('http://127.0.0.1:8001')
    const result = await integration.test()
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8001', expect.objectContaining({
      method: 'GET', redirect: 'manual',
    }))
    expect(cancel).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ state: 'reachable', status_code: 302, protocol_verified: false })
  })

  it('reports authentication as reachable, not as an App failure', async () => {
    const integration = createWrssIntegration({
      fetchImpl: async () => ({ status: 401, body: null }),
    })
    integration.save('http://127.0.0.1:8001')
    await expect(integration.test()).resolves.toMatchObject({
      state: 'reachable', status_code: 401,
      message: expect.stringContaining('鉴权'),
    })
  })

  it('classifies timeout without retrying', async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      throw error
    })
    const integration = createWrssIntegration({ fetchImpl })
    integration.save('http://127.0.0.1:8001')
    await expect(integration.test()).resolves.toMatchObject({ state: 'timeout' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
