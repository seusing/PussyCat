// @vitest-environment node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), 'index.mjs')

function startHost(env = {}) {
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, OPENCLI_HOST_PORT: '0', ...env },
    // 三条 pipe 本就是 Node 的默认值,这里写出来是**把前提摆到明面**:父进程存活通道的用例
    // 依赖 stdin 是管道(才有写端可关)。别让这个前提靠"默认值恰好如此"隐式成立。
    stdio: ['pipe', 'pipe', 'pipe'],
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
      // 没设开关 → 看门狗没挂 → 必须如实上报 false(supervisor 靠这个字段决定要不要 fail-closed)
      expect(ready.parentWatch).toBe(false)
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

  it('协议内失败 + 看门狗已挂:判定行完整,且仍以 1 退出(不因等排空而挂死)', async () => {
    // failReady 改成"等 stdout 写入回调再退"(避免管道异步写被 process.exit 截断)之后,
    // 能否退出就取决于回调与兜底定时器。这里刻意把 PARENT_WATCH 打开:stdin.resume() 会把
    // 事件循环 ref 住 —— 只设 process.exitCode 而不显式 exit 的写法会在这一支上永久挂死,
    // 对 supervisor 表现为 readiness-timeout(比丢判定行更糟)。断言退出码严格等于 1:
    // 写成 not.toBe(0) 的话,超时返回的字符串也能过,等于没测。
    const { child, firstJson } = startHost({
      OPENCLI_HOST_CATALOG_PATH: 'C:/definitely/not/here.json',
      OPENCLI_HOST_PARENT_WATCH: '1',
    })
    const ready = await firstJson.catch((e) => e)
    expect(ready.opencliHostReady).toBe(false)
    // 能解析成对象本身就是"判定行没被截断"的证据。
    expect(typeof ready.error.summary).toBe('string')
    const exited = new Promise((r) => child.once('exit', (code) => r(code)))
    const timedOut = new Promise((r) => setTimeout(() => r('未在 3s 内退出'), 3000))
    expect(await Promise.race([exited, timedOut])).toBe(1)
  }, 30000)
})

describe('父进程存活通道(stdin EOF 看门狗)', () => {
  it('开关打开:stdin 关闭 → 5s 内优雅退出,退出码 0', async () => {
    const { child, firstJson } = startHost({ OPENCLI_HOST_PARENT_WATCH: '1' })
    try {
      const ready = await firstJson
      expect(ready.opencliHostReady).toBe(true)
      // 判定行必须在**看门狗已挂上之后**才打印,parentWatch 才是事实而非意图。
      expect(ready.parentWatch).toBe(true)
      const exited = new Promise((r) => child.once('exit', (code) => r(code)))
      const timedOut = new Promise((r) => setTimeout(() => r('未在 5s 内退出'), 5000))
      // 模拟父进程消亡:关掉写端(supervisor 全程只持有、从不写入)。
      child.stdin.end()
      expect(await Promise.race([exited, timedOut])).toBe(0)
    } finally { child.kill('SIGKILL') }
  }, 30000)

  it('开关不设(默认):stdin 关闭后进程照活——看门狗由开关控制,dev:server 行为不变', async () => {
    const { child, firstJson } = startHost()
    try {
      const ready = await firstJson
      expect(ready.parentWatch).toBe(false)
      let observedExit = '仍在运行'
      child.once('exit', (code) => { observedExit = `已退出(${code})` })
      child.stdin.end()
      await new Promise((r) => setTimeout(r, 1500))
      expect(observedExit).toBe('仍在运行')
      expect(child.killed).toBe(false)
    } finally { child.kill('SIGKILL') }
  }, 30000)
})
