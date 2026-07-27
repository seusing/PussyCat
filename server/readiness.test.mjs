// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

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
  it('node 环境没有被 jsdom 那套全局桩污染', async () => {
    // `src/vitest.setup.ts` 把 fetch/localStorage 的桩按 `typeof window` 收窄到 jsdom 环境
    // (T2 顺手根治的仓库级耦合)。**那次收窄本身一直没有守卫**:把 `if (!isJsdomEnv) return`
    // 删掉,246 条测试仍会全绿,因为各 server 测试文件当年各自加过 unstub 兜底——
    // 于是收窄坏掉这件事会被这些兜底悄悄盖住。
    // 探针:原生 fetch 打一个必然拒绝的地址会很快 reject;"永不 settle"的桩则会挂到超时。
    await expect(fetch('http://127.0.0.1:1/')).rejects.toThrow()
  }, 10000)

  it('成功:恰一行机器可读 JSON,含真实随机端口与 policy 计数', async () => {
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

  it('协议内失败:legacy 基线损坏 → ready:false,而非模块求值期的裸 SyntaxError', async () => {
    // **I-3 回归钉。** 两处读盘(legacy 基线、catalog 快照)原本在**模块求值期**执行,
    // 而 index.mjs 的 try/catch 包住的是 loadExecutionPolicy,静态 ESM import 在 try **之前**求值。
    // 实测过的坏行为:基线损坏 → 裸 SyntaxError 抛在 module job 里,failReady() 从未被调用,
    // 判定行根本不出现 —— supervisor 把「协议内失败」误判成 process-failed,
    // 给用户的文案与排障方向全错(理由见 index.mjs failReady 的注释)。
    // 读盘改惰性 + memo 后,损坏必须落进 loadExecutionPolicy 的 try,走结构化失败。
    const dir = mkdtempSync(join(tmpdir(), 'opencli-legacy-'))
    const corrupt = join(dir, 'policy-legacy-baseline.json')
    writeFileSync(corrupt, '{ CORRUPT')
    try {
      const { child, firstJson } = startHost({ OPENCLI_HOST_LEGACY_BASELINE_PATH: corrupt })
      const ready = await firstJson.catch((e) => e)
      expect(ready.opencliHostReady).toBe(false)
      expect(typeof ready.error.summary).toBe('string')
      const code = await new Promise((r) => child.once('exit', r))
      expect(code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
