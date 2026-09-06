// @vitest-environment node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reviewShapeHash } from './policy-fingerprint.mjs'
import { COMMAND_POLICY_OVERRIDES } from './policy.mjs'

const baseline = JSON.parse(readFileSync(resolve('server/policy-legacy-baseline.json'), 'utf8'))
const snapshotRaw = readFileSync(resolve('public/catalog.snapshot.json'))
const snapshot = JSON.parse(snapshotRaw.toString('utf8').replace(/^﻿/, ''))

describe('legacy 基线 artifact', () => {
  it('固定源身份与来源 Git 对象匹配', () => {
    const sourceRaw = execFileSync('git', ['show', baseline.materializedFrom.gitBlob], {
      maxBuffer: 64 * 1024 * 1024,
    })
    const sha = createHash('sha256').update(sourceRaw).digest('hex')
    expect(baseline.materializedFrom.sha256).toBe(sha)
    expect(baseline.materializedFrom.path).toBe('public/catalog.snapshot.json')
    expect(baseline.opencliVersion).toBe(snapshot.opencliVersion)
  })

  // 上面那条是**自反的**:artifact 若从另一份快照重新物化,它的 sha 与当时的快照仍然自洽,
  // 三条断言全绿。要把身份钉在 spec §4.2 声明的那一份上,必须写死字面量。
  // 三个值已核实与 main@43d789b 的实际文件一致(2026-07-27)。
  it('固定源身份等于 spec §4.2 钉死的那一份,而非「某一份自洽的快照」', () => {
    expect(baseline.materializedFrom.sha256)
      .toBe('37ec65020d604f4dd4835111008676ff72661db0c145526b43263e12f69610c7')
    expect(baseline.materializedFrom.gitBlob)
      .toBe('93be28ea46a9e652922a6d7b85221383216c2c90')
    expect(baseline.opencliVersion).toBe('1.8.6')
  })

  it('条目 = P0-B 三条件派生结果 − 显式 deny,恰 276 条', () => {
    const derived = snapshot.commands
      .filter((c) => c.access === 'read' && c.strategy === 'public' && c.browser === false)
      .map((c) => c.command)
      .filter((k) => COMMAND_POLICY_OVERRIDES[k]?.decision !== 'deny')
    expect(Object.keys(baseline.entries).sort()).toEqual(derived.sort())
    expect(derived.length).toBe(276)
  })

  it('每条记录的 reviewShapeHash 与当前快照一致', () => {
    for (const [key, hash] of Object.entries(baseline.entries)) {
      const command = snapshot.commands.find((c) => c.command === key)
      expect(command, `${key} 不在快照里`).toBeDefined()
      expect(reviewShapeHash(command, snapshot.opencliVersion), key).toBe(hash)
    }
  })

  it('基线不含任何 browser 命令 —— 它只承接 P0-B 的直连只读面', () => {
    for (const key of Object.keys(baseline.entries)) {
      // 先 toBeDefined 再读 .browser:否则 key 不在快照里时抛的是 TypeError 而非断言失败,
      // 红是红了,但信息是「Cannot read properties of undefined」,指不到真正的原因。
      const command = snapshot.commands.find((c) => c.command === key)
      expect(command, `${key} 不在快照里`).toBeDefined()
      expect(command.browser, key).toBe(false)
    }
  })
})
