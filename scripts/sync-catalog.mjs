// 从本机 opencli 生成 catalog 快照（list 主源 + 包内 manifest 补字段）。
// 用法：npm run sync-catalog
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stripBom, mergeManifestFields } from '../src/data/normalize.ts'

const manifestPath = join(
  homedir(),
  'AppData/Roaming/npm/node_modules/@jackwener/opencli/cli-manifest.json',
)
const opencliCmd = join(homedir(), 'AppData/Roaming/npm/opencli.cmd')

// Windows: execFileSync 不能直接起 .cmd（非 OS 级可执行文件，需 shell 解释），
// 显式走 cmd.exe /c 而非 shell:true，避免 DEP0190 参数转义警告与注入面。
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
