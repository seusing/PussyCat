// 从本机 opencli 生成 catalog 快照（list 主源 + 包内 manifest 补字段）。
// 用法：npm run sync-catalog
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stripBom, mergeManifestFields } from '../src/shared/normalize.mjs'

const manifestPath = join(
  homedir(),
  'AppData/Roaming/npm/node_modules/@jackwener/opencli/cli-manifest.json',
)
const opencliCmd = join(homedir(), 'AppData/Roaming/npm/opencli.cmd')

// Windows: .cmd 不是 OS 级可执行文件，execFileSync 不带 shell 直接 spawn 会 EINVAL，
// 因此必须显式走 cmd.exe /c。
// 当前安全的真正原因：下面 4 个参数（opencliCmd / 'list' / '-f' / 'json'）都是脚本内硬编码常量，
// 没有任何外部/动态输入参与拼接——安全性来自"无外部输入"，不是来自"数组传参"本身。
// 警示：cmd.exe /c + argv 数组并不能防 cmd.exe 元字符注入——cmd.exe 仍会重新解析整条命令行，
// `& | ^ %VAR%` 等对它依旧是元字符。未来若把任何动态/外部/用户输入拼进这个 args 数组，
// 必须先做校验或白名单化。
const listRaw = stripBom(execFileSync('cmd.exe', ['/d', '/s', '/c', opencliCmd, 'list', '-f', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
const list = JSON.parse(listRaw)
const manifestRaw = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(stripBom(manifestRaw))

const commands = mergeManifestFields(list, manifest)
const snapshot = {
  schemaVersion: 1,
  generatedAt: Date.now(),
  opencliVersion: JSON.parse(readFileSync(join(homedir(), 'AppData/Roaming/npm/node_modules/@jackwener/opencli/package.json'), 'utf8')).version,
  source: 'opencli list -f json',
  listSha256: createHash('sha256').update(listRaw).digest('hex'),
  manifestSha256: createHash('sha256').update(manifestRaw).digest('hex'),
  commands,
}

mkdirSync('public', { recursive: true })
writeFileSync('public/catalog.snapshot.json', JSON.stringify(snapshot))
console.log(`catalog: ${commands.length} commands, ${new Set(commands.map((c) => c.site)).size} sites`)
