// @vitest-environment node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), 'index.mjs')

function startHost(env = {}) {
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, OPENCLI_HOST_PORT: '0', ...env },
    shell: false,
    windowsHide: true,
  })
  const firstJson = new Promise((resolvePromise, rejectPromise) => {
    let buf = ''
    const timer = setTimeout(() => rejectPromise(new Error(`readiness timeout; got: ${buf}`)), 20000)
    child.stdout.on('data', (chunk) => {
      buf += chunk
      for (const line of buf.split('\n')) {
        if (!line.includes('opencliHostReady')) continue
        clearTimeout(timer)
        try { resolvePromise(JSON.parse(line)) } catch (e) { rejectPromise(e) }
        return
      }
    })
    child.once('error', rejectPromise)
    child.once('exit', (code) => { clearTimeout(timer); rejectPromise(new Error(`exited ${code} before readiness; got: ${buf}`)) })
  })
  return { child, firstJson }
}

describe('readiness 协议', () => {
  it('成功:恰一行机器可读 JSON,含真实随机端口与 policy 计数', async () => {
    // src/vitest.setup.ts 的全局 beforeEach 把 fetch 桩成永不 settle(给 jsdom 组件测试防抖用,
    // 对 @vitest-environment node 的本文件同样生效)。本用例要用真实网络验证端口真的在监听,
    // 这里显式解桩还原原生 fetch;afterEach 的 unstubAllGlobals 之后仍会照常收尾。
    vi.unstubAllGlobals()
    const { child, firstJson } = startHost()
    try {
      const ready = await firstJson
      expect(ready.opencliHostReady).toBe(true)
      expect(Number.isInteger(ready.port)).toBe(true)
      expect(ready.port).toBeGreaterThan(0)
      expect(ready.pid).toBe(child.pid)
      expect(typeof ready.opencliVersion).toBe('string')
      expect(ready.policyCommands).toBeGreaterThan(0)
      // 端口真的在监听:能连上 /health
      const res = await fetch(`http://127.0.0.1:${ready.port}/health`, { headers: { Origin: 'http://127.0.0.1:5173' } })
      expect(res.status).toBe(200)
    } finally { child.kill('SIGKILL') }
  }, 30000)

  it('协议内失败:catalog 快照不可读 → ready:false + error,且非零退出', async () => {
    const { child, firstJson } = startHost({ OPENCLI_HOST_CATALOG_PATH: 'C:/definitely/not/here.json' })
    const ready = await firstJson.catch((e) => e)
    expect(ready.opencliHostReady).toBe(false)
    expect(typeof ready.error.summary).toBe('string')
    const code = await new Promise((r) => child.once('exit', r))
    expect(code).not.toBe(0)
  }, 30000)
})
