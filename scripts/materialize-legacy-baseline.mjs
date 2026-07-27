// **一次性**物化 legacy 基线。它不是构建步骤——构建、目录刷新、opencli 升级
// 一律只读取产物,禁止自动重建(spec §4.2)。
// 重跑它等于把「只读 + 只减不增」一次性作废,是所有 legacy 规则里唯一能被单个动作绕过的漏洞。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewShapeHash } from '../server/policy-fingerprint.mjs'
import { COMMAND_POLICY_OVERRIDES } from '../server/policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'server/policy-legacy-baseline.json')

if (existsSync(out) && !process.argv.includes('--force')) {
  console.error('[legacy] 产物已存在。它是一次性物化的只读 artifact;确需重建请显式 --force 并在 PR 里说明理由。')
  process.exit(1)
}

const snapshotPath = resolve(root, 'public/catalog.snapshot.json')
const raw = readFileSync(snapshotPath)
const snapshot = JSON.parse(raw.toString('utf8').replace(/^﻿/, ''))
const entries = {}
for (const command of snapshot.commands) {
  if (!(command.access === 'read' && command.strategy === 'public' && command.browser === false)) continue
  if (COMMAND_POLICY_OVERRIDES[command.command]?.decision === 'deny') continue
  entries[command.command] = reviewShapeHash(command, snapshot.opencliVersion)
}

const artifact = {
  materializedFrom: {
    path: 'public/catalog.snapshot.json',
    gitBlob: execFileSync('git', ['rev-parse', 'HEAD:public/catalog.snapshot.json'], { cwd: root, encoding: 'utf8' }).trim(),
    sha256: createHash('sha256').update(raw).digest('hex'),
  },
  opencliVersion: snapshot.opencliVersion,
  entries,
}
writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`)
console.log(`[legacy] 物化 ${Object.keys(entries).length} 条 → ${out}`)
