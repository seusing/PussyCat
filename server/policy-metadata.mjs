// 人工审定记录。审定依据见 spec §9.1——本文件是那份审定的可执行形式。
// reviewedAgainst 由 reviewShapeHash 回填(见下方 shapeOf)。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewShapeHash } from './policy-fingerprint.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const snapshot = JSON.parse(
  readFileSync(join(projectRoot, 'public/catalog.snapshot.json'), 'utf8').replace(/^﻿/, ''),
)
const shapeOf = (key) => {
  const command = snapshot.commands.find((c) => c.command === key)
  if (!command) throw new Error(`审定记录指向 catalog 里不存在的命令: ${key}`)
  return reviewShapeHash(command, snapshot.opencliVersion)
}

export const REVIEWED_RECORDS = new Map([
  ['trae-cn/setup', {
    reviewedAgainst: shapeOf('trae-cn/setup'),
    metadata: {
      executionPath: 'direct-node',
      // 空集:它只打印本地 setup 说明文本,不访问网络、不读用户文件。
      authorities: [],
      exposure: 'public',
      effects: [],
      credentialFlow: 'none',
      residues: [],
    },
  }],
  ['mercury/reimbursement-plan', {
    reviewedAgainst: shapeOf('mercury/reimbursement-plan'),
    metadata: {
      executionPath: 'direct-node',
      // 用户在本次调用中显式指定报销资料(receipt/amount/merchant/notes 均必填)。
      authorities: ['explicit-local-input'],
      exposure: 'personal',
      effects: [],
      credentialFlow: 'none',
      residues: [],
    },
  }],
  ['antigravity/recent-paths', {
    reviewedAgainst: shapeOf('antigravity/recent-paths'),
    metadata: {
      executionPath: 'direct-node',
      // 主动扫描 Antigravity 的 history.recentlyOpenedPathsList——用户没指定读什么。
      authorities: ['ambient-local-files'],
      exposure: 'personal',
      effects: [],
      credentialFlow: 'none',
      residues: [],
    },
  }],
])
