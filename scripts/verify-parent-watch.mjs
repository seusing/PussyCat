// 不变式 I2 的证据:**父进程猝死 → Host 靠 stdin EOF 自退**。
//
// 为什么真机上 `taskkill /F` 打 Tauri 主进程证不了这条:正常路径里 Job Object 与 stdin EOF
// 两条通道同时在场,Host 消失完全可能全是 `KILL_ON_JOB_CLOSE` 的功劳 —— 哪怕看门狗已经坏掉,
// 那个测试照样全绿。要证通道 2,必须把通道 1 拿走。
//
// 本脚本的做法:用一个不创建 Job Object 的 Node「站位父进程」拉起真实 Host,再强杀它。
// 关键是**先跑零假设对照组**:
//   · 对照组(OPENCLI_HOST_PARENT_WATCH=0):强杀站位父进程后,Host 必须**活着**。
//     它要是也死了,说明是环境在回收进程树,实验组的"死亡"就毫无信息量 —— 判 INVALID,不判 PASS。
//   · 实验组(=1):同样的 spawn、同样的 detached、只差这一个环境变量 → Host 必须自退。
// 两组之差只有看门狗,因果才唯一。
//
// 用法(手工门,不进 vitest —— 它要强杀进程):
//   node scripts/verify-parent-watch.mjs
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessEntry = resolve(projectRoot, 'scripts/_parent-watch-harness.mjs')
// 优先验**要发的那份**(dist-host),没有才退回源码树。
const distHost = resolve(projectRoot, 'dist-host/server/index.mjs')
const hostEntry = existsSync(distHost) ? distHost : resolve(projectRoot, 'server/index.mjs')

const SURVIVE_WINDOW_MS = 6000
const POLL_MS = 250

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// 身份 = pid + 创建时间。只认 pid 会被 pid 复用骗:短窗口里概率极低,但"极低"不是证据。
function processIdentity(pid) {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p.CreationDate.ToFileTimeUtc() }`,
    ], { encoding: 'utf8', windowsHide: true }).trim()
    return out || null
  } catch {
    return null
  }
}

function stillAlive(pid, identity) {
  const now = processIdentity(pid)
  return now !== null && now === identity
}

function forceKill(pid, tree = false) {
  try {
    // 打站位父进程时**绝不能带 /T**:带上就是杀整棵树,Host 死于 taskkill 而非 EOF,实验作废。
    execFileSync('taskkill.exe', tree ? ['/F', '/T', '/PID', String(pid)] : ['/F', '/PID', String(pid)], {
      stdio: 'ignore', windowsHide: true,
    })
  } catch { /* 已经不在了 */ }
}

function startHarness(parentWatch) {
  const harness = spawn(process.execPath, [harnessEntry], {
    env: {
      ...process.env,
      OPENCLI_HOST_ENTRY: hostEntry,
      OPENCLI_HOST_PARENT_WATCH: parentWatch ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  })
  const announced = new Promise((resolvePromise, rejectPromise) => {
    let buf = ''
    const timer = setTimeout(() => rejectPromise(new Error(`Host 未在 20s 内就绪;harness 输出: ${buf}`)), 20000)
    harness.stdout.on('data', (chunk) => {
      buf += chunk
      const line = buf.split('\n').find((l) => l.startsWith('HOSTPID '))
      if (!line) return
      clearTimeout(timer)
      const [, pid, ready, watch] = line.trim().split(/\s+/)
      resolvePromise({
        hostPid: Number.parseInt(pid, 10),
        ready: ready === 'ready=true',
        parentWatch: watch === 'parentWatch=true',
      })
    })
    harness.stderr.on('data', (chunk) => process.stderr.write(`[harness stderr] ${chunk}`))
    harness.once('exit', (code) => { clearTimeout(timer); rejectPromise(new Error(`harness 提前退出(${code});输出: ${buf}`)) })
  })
  return { harness, announced }
}

async function runPhase({ label, parentWatch, expectSurvival }) {
  const { harness, announced } = startHarness(parentWatch)
  const info = await announced
  if (!info.ready) throw new Error(`${label}: Host 未就绪`)
  if (info.parentWatch !== parentWatch) {
    // 两组的唯一差别必须成立。dist-host 是构建产物,可能是没有看门狗的旧版本 —— 那样实验组
    // 会"看起来失败"却根本没装上看门狗,必须当场识破而不是记成一次失败。
    throw new Error(`${label}: Host 自报 parentWatch=${info.parentWatch},与预期 ${parentWatch} 不符(dist-host 可能是旧版本,先跑 npm run build:host)`)
  }

  const identity = processIdentity(info.hostPid)
  if (!identity) throw new Error(`${label}: 拿不到 Host(pid ${info.hostPid})的身份`)
  console.log(`  站位父进程 pid=${harness.pid} → Host pid=${info.hostPid} parentWatch=${info.parentWatch}`)

  forceKill(harness.pid)                      // 无 /T:只杀站位父进程
  console.log(`  已 taskkill /F 站位父进程 ${harness.pid}(未带 /T)`)

  const deadline = Date.now() + SURVIVE_WINDOW_MS
  let aliveAtEnd = true
  let diedAfterMs = null
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    if (!stillAlive(info.hostPid, identity)) {
      aliveAtEnd = false
      diedAfterMs = SURVIVE_WINDOW_MS - (deadline - Date.now())
      break
    }
  }

  if (aliveAtEnd) forceKill(info.hostPid, true)   // 收尾:自己拉起的孤儿自己收

  const pass = expectSurvival ? aliveAtEnd : !aliveAtEnd
  console.log(`  结果:Host ${aliveAtEnd ? `在 ${SURVIVE_WINDOW_MS}ms 后仍存活` : `已在 ~${diedAfterMs}ms 内退出`} → ${pass ? 'PASS' : 'FAIL'}`)
  return { pass, aliveAtEnd, hostPid: info.hostPid }
}

console.log(`Host 入口: ${hostEntry}`)
console.log('')
console.log('阶段 A —— 零假设对照组(看门狗关闭):强杀站位父进程后 Host 必须存活')
const control = await runPhase({ label: '对照组', parentWatch: false, expectSurvival: true })
if (!control.pass) {
  console.log('')
  console.log('INVALID:关掉看门狗的 Host 也跟着死了 —— 是环境在回收进程树,不是 stdin EOF 起作用。')
  console.log('        实验组无论结果如何都不构成证据。')
  process.exit(2)
}

console.log('')
console.log('阶段 B —— 实验组(看门狗开启):强杀站位父进程后 Host 必须自退')
const experiment = await runPhase({ label: '实验组', parentWatch: true, expectSurvival: false })

console.log('')
if (experiment.pass) {
  console.log('PASS:同样的 spawn、同样的 detached、全程无 Job Object,只差 OPENCLI_HOST_PARENT_WATCH ——')
  console.log('      关时存活、开时自退。通道 2(stdin EOF)在"父进程猝死"下确实工作。')
  process.exit(0)
}
console.log('FAIL:看门狗开启时 Host 仍未自退 —— 通道 2 不成立。')
process.exit(1)
