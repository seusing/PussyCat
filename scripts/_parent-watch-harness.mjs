// 「站位父进程」——只做 Tauri supervisor 在通道 2 上做的那一件事:持有 Host stdin 的写端,且从不写入。
//
// 它**不创建 Job Object**(Node 也创建不了)。这正是本 harness 存在的意义:
// 真机上强杀 Tauri 主进程时,Job Object 与 stdin EOF 两条通道同时在场,Host 消失说明不了
// 究竟是哪条起了作用。把 Job Object 拿掉,剩下的因果就唯一了。
//
// 由 scripts/verify-parent-watch.mjs 拉起,不单独使用。
import { spawn } from 'node:child_process'

const hostEntry = process.env.OPENCLI_HOST_ENTRY
if (!hostEntry) {
  console.error('[harness] OPENCLI_HOST_ENTRY 未设置')
  process.exit(2)
}

const child = spawn(process.execPath, [hostEntry], {
  env: { ...process.env, OPENCLI_HOST_PORT: '0' },
  // 三条 pipe:stdin 是管道才有"写端"可关,这是通道 2 的物理前提。
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: false,
  windowsHide: true,
  // 本机实测过(P1 T5):普通孙进程会跟着父进程一起被回收。不 detach 的话"对照组存活"
  // 根本不可能成立,实验会退化成"环境替我们收的尸",什么也证明不了。
  detached: true,
})
child.unref()

let reported = false
let buf = ''
child.stdout.on('data', (chunk) => {
  if (reported) return
  buf += chunk
  for (const line of buf.split('\n')) {
    if (!line.includes('opencliHostReady')) continue
    let ready
    try { ready = JSON.parse(line) } catch { return }
    reported = true
    // 把 parentWatch 一并回报:对照组与实验组的唯一差别必须是它,由编排脚本断言。
    process.stdout.write(`HOSTPID ${child.pid} ready=${ready.opencliHostReady} parentWatch=${ready.parentWatch}\n`)
    return
  }
})
// 排空 stderr,免得 Host 写日志时被管道背压卡住。
child.stderr.resume()

// 活着不动:等编排脚本来强杀。
setInterval(() => {}, 1000)
