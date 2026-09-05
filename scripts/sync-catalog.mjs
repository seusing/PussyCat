// 从本机 opencli 生成 catalog 快照（list 主源 + 包内 manifest 补字段）。
// 用法：npm run sync-catalog
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stripBom, mergeManifestFields } from '../src/shared/normalize.mjs'

const packageRoot = resolve('node_modules/@jackwener/opencli')
const manifestPath = join(packageRoot, 'cli-manifest.json')
const opencliEntry = join(packageRoot, 'dist/src/main.js')

// Use the package's local Node entry so catalog generation does not depend on
// a separately installed global OpenCLI binary.
const listRaw = stripBom(execFileSync(process.execPath, [opencliEntry, 'list', '-f', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
const list = JSON.parse(listRaw)
const manifestRaw = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(stripBom(manifestRaw))

const commands = mergeManifestFields(list, manifest)
const snapshot = {
  schemaVersion: 1,
  generatedAt: Date.now(),
  opencliVersion: JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version,
  source: 'opencli list -f json',
  listSha256: createHash('sha256').update(listRaw).digest('hex'),
  manifestSha256: createHash('sha256').update(manifestRaw).digest('hex'),
  commands,
}

mkdirSync('public', { recursive: true })
writeFileSync('public/catalog.snapshot.json', JSON.stringify(snapshot))
console.log(`catalog: ${commands.length} commands, ${new Set(commands.map((c) => c.site)).size} sites`)
