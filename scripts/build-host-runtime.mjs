// 生成自包含 Host runtime 到 dist-host/。
// 铁律:dist-host 必须镜像仓内相对拓扑(server/ 用相对 import 引 ../src/shared/*.mjs),拍平必断。
// 可复现性:opencli 及其 production 依赖由 host-runtime/package-lock.json 钉死,用 npm ci 安装。
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist-host')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// 1) 固定版 OpenCLI production tree(npm ci 严格按 lockfile)
cpSync(join(root, 'host-runtime/package.json'), join(out, 'package.json'))
cpSync(join(root, 'host-runtime/package-lock.json'), join(out, 'package-lock.json'))
// Windows 上 npm 的可执行入口是 .cmd;Node 的安全策略(CVE-2024-27980 后)让
// execFileSync/spawn 不带 shell 直接起 .bat/.cmd 一律 EINVAL(哪怕给全路径)。
// execSync 内建走 shell(Windows 用 cmd.exe,POSIX 用 /bin/sh),天然绕开这个限制且跨平台一致;
// 命令字符串是脚本内硬编码字面量、无任何外部/动态输入拼接,不构成注入面。
execSync('npm ci --omit=dev', { cwd: out, stdio: 'inherit' })

// 2) 镜像拓扑拷贝(server + src/shared + public 快照)
cpSync(join(root, 'server'), join(out, 'server'), { recursive: true, filter: (p) => !p.endsWith('.test.mjs') })
cpSync(join(root, 'src/shared'), join(out, 'src/shared'), { recursive: true, filter: (p) => !p.includes('.test.') })
mkdirSync(join(out, 'public'), { recursive: true })
cpSync(join(root, 'public/catalog.snapshot.json'), join(out, 'public/catalog.snapshot.json'))

// 3) 全树 SHA-256 清单(校验用)
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}
const files = walk(out).filter((p) => !p.endsWith('runtime-manifest.json')).sort()
const entries = files.map((p) => ({
  path: relative(out, p).replace(/\\/g, '/'),
  sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
}))
writeFileSync(join(out, 'runtime-manifest.json'), JSON.stringify({ fileCount: entries.length, files: entries }, null, 2))
console.log(`[build-host-runtime] ${entries.length} files -> ${out}`)
