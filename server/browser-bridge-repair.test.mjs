import { describe, expect, test, vi } from 'vitest'
import {
  discoverChromeExecutable,
  launchBrowser,
  repairBrowserBridge,
  runOpenCli,
} from './browser-bridge-repair.mjs'

const health = (over = {}) => ({
  checkedAt: 1, daemon: 'running', extension: 'connected', profile: 'ready',
  profileCount: 1, retryable: false, reasonCode: 'ok', summary: '浏览器桥接就绪', ...over,
})
const stopped = health({ daemon: 'stopped', extension: 'unknown', profile: 'unknown', reasonCode: 'daemon-stopped', summary: 'daemon 未运行' })
const noExt = health({ extension: 'disconnected', profile: 'unknown', reasonCode: 'extension-disconnected', summary: 'daemon 在运行,但 Chrome 扩展未连上' })
const multiProfile = health({ profile: 'required', profileCount: 2, reasonCode: 'profile-required', summary: '有多个浏览器 profile 连着' })

/** probe 依次返回给定序列 —— 修复阶梯每一级之后都要复检,顺序即语义。 */
function probeSequence(...results) {
  const queue = [...results]
  return vi.fn(async () => queue.length > 1 ? queue.shift() : queue[0])
}

describe('修复阶梯', () => {
  test('本来就好:不做任何动作,也不谎报"修好了"', async () => {
    const restartDaemon = vi.fn()
    const result = await repairBrowserBridge({ probe: probeSequence(health()), restartDaemon, openBrowser: vi.fn() })

    expect(restartDaemon).not.toHaveBeenCalled()
    expect(result.steps).toEqual([])
    expect(result.alreadyOk).toBe(true)
    expect(result.repaired).toBe(false)   // 没修过,就不算修好
  })

  test('daemon 没起来:重启后复检通过,这才叫 repaired', async () => {
    const restartDaemon = vi.fn(async () => ({ failed: false, code: 0 }))
    const result = await repairBrowserBridge({
      probe: probeSequence(stopped, health()), restartDaemon, openBrowser: vi.fn(),
    })

    expect(restartDaemon).toHaveBeenCalledTimes(1)
    expect(result.steps).toEqual([{ action: 'daemon-restart', outcome: 'done', detail: undefined }])
    expect(result.health.reasonCode).toBe('ok')
    expect(result.repaired).toBe(true)
  })

  test('动作成功 ≠ 修好了:重启跑通但桥接仍未就绪,repaired 必须为 false', async () => {
    const result = await repairBrowserBridge({
      probe: probeSequence(stopped, noExt),
      restartDaemon: vi.fn(async () => ({ failed: false, code: 0 })),
      openBrowser: vi.fn(async () => ({ launched: true })),
    })

    // 这是本模块最容易犯的谎:把"我执行了一个动作"当成"问题解决了"。
    expect(result.repaired).toBe(false)
    expect(result.health.reasonCode).toBe('extension-disconnected')
  })

  test('扩展未连接:机器修不了,只尝试开浏览器,并给出可照做的下一步', async () => {
    const openBrowser = vi.fn(async () => ({ launched: true }))
    const restartDaemon = vi.fn()
    const result = await repairBrowserBridge({ probe: probeSequence(noExt), restartDaemon, openBrowser })

    expect(restartDaemon).not.toHaveBeenCalled()        // 不是 daemon 的问题,别乱重启
    expect(openBrowser).toHaveBeenCalledTimes(1)
    expect(result.steps).toEqual([{ action: 'launch-browser', outcome: 'done', detail: undefined }])
    expect(result.repaired).toBe(false)
    expect(result.nextStep).toContain('OpenCLI 扩展')
  })

  test('找不到 Chrome 时如实记 failed,不静默当作做过了', async () => {
    const result = await repairBrowserBridge({
      probe: probeSequence(noExt),
      restartDaemon: vi.fn(),
      openBrowser: vi.fn(async () => ({ launched: false, reason: 'chrome-not-found' })),
    })

    expect(result.steps[0]).toEqual({ action: 'launch-browser', outcome: 'failed', detail: 'chrome-not-found' })
  })

  test('多 profile:不替用户挑,标记需要人来选', async () => {
    const result = await repairBrowserBridge({
      probe: probeSequence(multiProfile), restartDaemon: vi.fn(), openBrowser: vi.fn(),
    })

    expect(result.needsProfileChoice).toBe(true)
    expect(result.steps).toEqual([])                    // 没有任何机器动作可做
    expect(result.nextStep).toContain('选一个')
  })

  test('禁用浏览器拉起时不碰浏览器 —— 副作用要能关掉', async () => {
    const openBrowser = vi.fn()
    await repairBrowserBridge({
      probe: probeSequence(noExt), restartDaemon: vi.fn(), openBrowser, allowBrowserLaunch: false,
    })

    expect(openBrowser).not.toHaveBeenCalled()
  })
})

describe('Chrome 发现', () => {
  test('Windows 走标准安装位置', () => {
    const found = discoverChromeExecutable({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      existsImpl: (p) => p.startsWith('C:\\Users\\u\\AppData\\Local'),
    })
    expect(found).toBe('C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
  })

  test('一个都不存在时返回 null —— 由调用方如实说"找不到",不猜一个路径去 spawn', () => {
    expect(discoverChromeExecutable({ platform: 'win32', env: { ProgramFiles: 'C:\\PF' }, existsImpl: () => false })).toBeNull()
    expect(discoverChromeExecutable({ platform: 'darwin', existsImpl: () => false })).toBeNull()
  })

  test('缺少环境变量不炸', () => {
    expect(discoverChromeExecutable({ platform: 'win32', env: {}, existsImpl: () => true })).toBeNull()
  })
})

describe('浏览器拉起', () => {
  test('拉起后 detach 并 unref —— 关掉爪爪不该连带杀掉用户的浏览器', async () => {
    const unref = vi.fn()
    const spawnImpl = vi.fn(() => ({ unref }))
    const result = await launchBrowser({ discover: () => 'C:\\chrome.exe', spawnImpl })

    expect(result).toEqual({ launched: true })
    expect(spawnImpl).toHaveBeenCalledWith('C:\\chrome.exe', [], expect.objectContaining({ detached: true, stdio: 'ignore' }))
    expect(unref).toHaveBeenCalled()
  })

  test('spawn 抛错时不外泄异常,转成结构化失败', async () => {
    const result = await launchBrowser({
      discover: () => 'C:\\chrome.exe',
      spawnImpl: () => { throw new Error('EACCES') },
    })
    expect(result.launched).toBe(false)
    expect(result.reason).toBe('spawn-failed')
  })
})

describe('opencli 子进程', () => {
  test('退出码 0 = 成功', async () => {
    const spawnImpl = vi.fn(() => {
      const handlers = {}
      queueMicrotask(() => handlers.close?.(0))
      return { once: (e, fn) => { handlers[e] = fn }, kill: vi.fn() }
    })
    await expect(runOpenCli(['daemon', 'restart'], { opencliEntry: '/entry.js', spawnImpl }))
      .resolves.toEqual({ code: 0, failed: false })
  })

  test('非零退出码 = 失败(不把失败当成功吞掉)', async () => {
    const spawnImpl = vi.fn(() => {
      const handlers = {}
      queueMicrotask(() => handlers.close?.(1))
      return { once: (e, fn) => { handlers[e] = fn }, kill: vi.fn() }
    })
    const result = await runOpenCli(['daemon', 'restart'], { opencliEntry: '/entry.js', spawnImpl })
    expect(result.failed).toBe(true)
  })

  test('超时会杀掉子进程并如实标记 —— 卡住的 daemon 不该把按钮挂死', async () => {
    const kill = vi.fn()
    const spawnImpl = vi.fn(() => ({ once: () => {}, kill }))
    const result = await runOpenCli(['daemon', 'restart'], { opencliEntry: '/entry.js', spawnImpl, timeoutMs: 5 })

    expect(kill).toHaveBeenCalled()
    expect(result).toEqual({ code: null, failed: true, detail: 'timeout' })
  })
})
