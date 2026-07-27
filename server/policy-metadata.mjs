// 人工审定记录。审定依据见 spec §9.1——本文件是那份审定的可执行形式。
// reviewedAgainst 由 reviewShapeHash 回填(见下方 shapeOf)。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewShapeHash } from './policy-fingerprint.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 读盘**惰性 + memo**:模块求值期一律不碰磁盘。理由见 policy.mjs 里 legacyBaseline() 的注释——
// index.mjs 的 try/catch 在静态 import **之后**才生效,顶层 JSON.parse 一旦失败就是裸 SyntaxError,
// failReady() 收不到,supervisor 拿不到 opencliHostReady:false。
let snapshotMemo = null
function snapshot() {
  if (snapshotMemo === null) {
    snapshotMemo = JSON.parse(
      readFileSync(join(projectRoot, 'public/catalog.snapshot.json'), 'utf8').replace(/^﻿/, ''),
    )
  }
  return snapshotMemo
}

const shapeMemo = new Map()
const shapeOf = (key) => {
  if (shapeMemo.has(key)) return shapeMemo.get(key)
  const current = snapshot()
  const command = current.commands.find((c) => c.command === key)
  if (!command) throw new Error(`审定记录指向 catalog 里不存在的命令: ${key}`)
  const shape = reviewShapeHash(command, current.opencliVersion)
  shapeMemo.set(key, shape)
  return shape
}

// reviewedAgainst 用 **getter** 而非立即求值:算它要读快照,而读盘必须惰性(见上)。
// getter 是自有访问器属性,`Object.hasOwn(record, 'reviewedAgainst')` 与
// `typeof record.reviewedAgainst === 'string'` 都照常成立,故 isCompleteRecord 无需改动,
// 导出的仍是一个货真价实的 Map —— 既有消费方与测试**一行都不用改**。
export const REVIEWED_RECORDS = new Map([
  ['trae-cn/setup', {
    get reviewedAgainst() { return shapeOf('trae-cn/setup') },
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
    get reviewedAgainst() { return shapeOf('mercury/reimbursement-plan') },
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
    get reviewedAgainst() { return shapeOf('antigravity/recent-paths') },
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
