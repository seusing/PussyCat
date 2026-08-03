// BrowserBridge 修复阶梯 —— 「检测并修复」按钮背后的机器动作。
//
// **这个模块的第一职责是不说谎。** 逐条对着 reasonCode 核过 opencli 源码之后,
// 四类故障里机器真正能自己搞定的只有一类:
//
//   · daemon-stopped / daemon-unreachable → **真能修**。`opencli daemon restart`
//     在守护进程没跑时走的是 "started" 分支(commands/daemon.js:87 用
//     previousStatus 区分 restarted/started),所以停着和卡死两种情形同一条命令覆盖。
//   · extension-disconnected → **机器修不了**。扩展连不连是 Chrome 那边的事;
//     能做的只是把 Chrome 拉起来,而它连上与否仍取决于打开的 profile 装没装扩展。
//     所以这一档如实记成「尝试打开浏览器」,再复检一次看结果,绝不因为"动作执行了"
//     就报成功。
//   · profile-required → **要用户选**。机器不能替他决定用哪个浏览器身份。
//   · profile-disconnected → **修不了**。要用户去打开那个 profile。
//
// 为什么走 CLI 子进程而不是 import:`browser/daemon-lifecycle.js` 里的
// restartDaemon / ensureBrowserBridgeReady 正是想要的原语,但 @jackwener/opencli
// 的 package.json exports 没有映射 `./browser/daemon-lifecycle`(与 `./doctor`、
// `./browser/daemon-client` 同一个坑,见 browser-bridge-health.mjs 顶部注释),
// Node 的 exports 约束下根本 import 不到。CLI 是本仓唯一稳定拿得到的执行面。
// 注意仍**不解析人读 stdout** 来取状态:动作走 CLI,状态一律回到 /status 的结构化投影。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DAEMON_RESTART_TIMEOUT_MS = 20_000
const PROFILE_USE_TIMEOUT_MS = 10_000

/** 机器能自己动手的 reasonCode —— 其余一律交回给人,并给出可照做的下一步。 */
const MACHINE_FIXABLE = new Set(['daemon-stopped', 'daemon-unreachable', 'daemon-error'])

// 修不了的那几类,给的是"照着做就行"的具体指令,不是状态词的同义反复。
const NEXT_STEP = {
  'extension-disconnected':
    '在 Chrome 里打开装有 OpenCLI 扩展的窗口,并确认该扩展处于启用状态;完成后再点一次「检测并修复」。',
  'profile-required':
    '当前有多个浏览器 profile 连着,需要指定用哪一个 —— 在下面选一个即可。',
  'profile-disconnected':
    '之前指定的浏览器 profile 现在没连上:打开那个 Chrome profile,或改选另一个。',
}

/**
 * 找 Chrome 可执行文件。
 *
 * opencli 自带的 launcher.discoverAppPath 只在 darwin 上有用(它走 osascript,
 * 非 darwin 直接 return null),Windows 上等于没有 —— 所以这里自己找。
 * 只查标准安装位置,**不去读注册表**:多一个平台相关的外部调用,换来的覆盖率
 * 提升很小,而找不到时的兜底本来就是"如实说找不到,请你手动打开"。
 */
export function discoverChromeExecutable({
  platform = process.platform,
  env = process.env,
  existsImpl = existsSync,
} = {}) {
  const candidates = []
  if (platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
      if (root) candidates.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser')
  }
  return candidates.find((path) => existsImpl(path)) ?? null
}

/** 拉起浏览器。**只开窗口,不带 profile 参数** —— Chrome 会恢复用户上次的 profile,
 *  那通常正是装了扩展的那个;强行指定反而可能开出一个没装扩展的干净 profile。 */
export async function launchBrowser({
  discover = discoverChromeExecutable,
  spawnImpl = spawn,
} = {}) {
  const executable = discover()
  if (!executable) {
    return { launched: false, reason: 'chrome-not-found' }
  }
  try {
    const child = spawnImpl(executable, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref?.()
    return { launched: true }
  } catch (error) {
    return { launched: false, reason: 'spawn-failed', detail: error?.message ?? String(error) }
  }
}

/** 跑一条 opencli 子命令。只关心退出码,状态一律回 /status 拿结构化的。 */
export function runOpenCli(argv, {
  opencliEntry,
  nodePath = process.execPath,
  spawnImpl = spawn,
  timeoutMs = DAEMON_RESTART_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(nodePath, [opencliEntry, ...argv], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, failed: true, detail: error?.message ?? String(error) })
      return
    }
    let settled = false
    const done = (result) => { if (!settled) { settled = true; resolve(result) } }
    const timer = setTimeout(() => { child.kill?.(); done({ code: null, failed: true, detail: 'timeout' }) }, timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); done({ code: null, failed: true, detail: error?.message ?? String(error) }) })
    child.once('close', (code) => { clearTimeout(timer); done({ code, failed: code !== 0 }) })
  })
}

/**
 * 走一遍修复阶梯,返回**做了什么**与**做完之后的真实状态**。
 *
 * 契约上最要紧的一条:`repaired` 只看最终复检的 reasonCode,不看动作有没有执行成功。
 * 「重启了 daemon」和「桥接好了」是两件事,把前者当后者报就是这个按钮最容易犯的谎。
 */
export async function repairBrowserBridge({
  probe,
  restartDaemon,
  openBrowser,
  allowBrowserLaunch = true,
} = {}) {
  const steps = []
  let health = await probe()

  if (health.reasonCode === 'ok') {
    return { steps, health, repaired: false, alreadyOk: true }
  }

  if (MACHINE_FIXABLE.has(health.reasonCode)) {
    const result = await restartDaemon()
    steps.push({
      action: 'daemon-restart',
      outcome: result.failed ? 'failed' : 'done',
      detail: result.detail,
    })
    health = await probe()
  }

  // daemon 起来之后仍是扩展没连 —— 这是修复阶梯的第二级,也是机器能力的边界。
  if (health.reasonCode === 'extension-disconnected' && allowBrowserLaunch) {
    const result = await openBrowser()
    steps.push({
      action: 'launch-browser',
      outcome: result.launched ? 'done' : 'failed',
      detail: result.launched ? undefined : result.reason,
    })
    // 不在这里复检:Chrome 冷启动 + 扩展握手远超一次探测的等待窗口,
    // 立刻复检只会稳定地拿到"还没连上",把一次可能成功的修复报成失败。
    // 交给窗口重获焦点时的自动重探 —— 用户开完浏览器切回来那一刻正好。
  }

  const nextStep = health.reasonCode === 'ok' ? undefined : NEXT_STEP[health.reasonCode] ?? health.summary
  return {
    steps,
    health,
    repaired: health.reasonCode === 'ok' && steps.length > 0,
    alreadyOk: false,
    needsProfileChoice: health.reasonCode === 'profile-required',
    nextStep,
  }
}

export { DAEMON_RESTART_TIMEOUT_MS, PROFILE_USE_TIMEOUT_MS, MACHINE_FIXABLE, NEXT_STEP }
