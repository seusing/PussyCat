// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reviewShapeHash, decisionFingerprint, canonicalJson } from './policy-fingerprint.mjs'
import { REVIEWED_RECORDS } from './policy-metadata.mjs'

const snapshot = JSON.parse(readFileSync(resolve('public/catalog.snapshot.json'), 'utf8').replace(/^﻿/, ''))
const find = (key) => snapshot.commands.find((c) => c.command === key)
const V = snapshot.opencliVersion

describe('reviewShapeHash', () => {
  it('同一命令稳定,不同命令不同', () => {
    const a = reviewShapeHash(find('trae-cn/setup'), V)
    expect(reviewShapeHash(find('trae-cn/setup'), V)).toBe(a)
    expect(reviewShapeHash(find('mercury/reimbursement-plan'), V)).not.toBe(a)
  })

  it('opencli 版本变化 → 审定失效', () => {
    const cmd = find('trae-cn/setup')
    expect(reviewShapeHash(cmd, '1.8.7')).not.toBe(reviewShapeHash(cmd, V))
  })

  it('展示性字段变化不进哈希', () => {
    const cmd = find('antigravity/recent-paths')
    const base = reviewShapeHash(cmd, V)
    for (const field of ['description', 'example', 'aliases']) {
      expect(reviewShapeHash({ ...cmd, [field]: 'CHANGED' }, V), `${field} 不该进哈希`).toBe(base)
    }
  })

  it('每个行为字段变化都改变哈希', () => {
    const cmd = find('antigravity/recent-paths')
    const base = reviewShapeHash(cmd, V)
    const mutations = {
      access: 'write', strategy: 'public', browser: true, siteSession: 'persistent',
      modulePath: 'other.js', domain: 'evil.example', navigateBefore: true,
      defaultWindowMode: 'headless', defaultFormat: 'yaml', type: 'other',
      columns: ['x'],
    }
    for (const [field, value] of Object.entries(mutations)) {
      expect(reviewShapeHash({ ...cmd, [field]: value }, V), `${field} 必须进哈希`).not.toBe(base)
    }
  })

  // **一个字段一条用例**,不要塞进 for 循环。
  // 教训(T1 同形复发):循环里第一条 expect 失败即抛异常,后面的字段**根本不会被执行**——
  // 于是「实现漏哈希了某字段」和「测试压根没跑到该字段」在输出上长得一模一样。
  // 每道守卫必须各自可见、各自能红。
  it.each([
    ['name', { name: 'x' }],
    ['type', { type: 'str' }],
    ['required', { required: true }],
    ['valueRequired', { valueRequired: true }],   // 原值是 false,必须翻成 true 才是真变异
    ['default', { default: 99 }],                 // 原值 20;经 appStore 播种 values 间接改变 argv
    ['choices', { choices: ['a'] }],              // 原值 []
  ])('arg 字段 %s 改变 reviewShapeHash', (_field, over) => {
    const cmd = find('antigravity/recent-paths')
    const base = reviewShapeHash(cmd, V)
    const patched = { ...cmd, args: [{ ...cmd.args[0], ...over }] }
    // 先证明这确实是一次真变异:改后的值必须与原值不同,否则这条用例什么也没测
    const [key] = Object.keys(over)
    expect(JSON.stringify(patched.args[0][key]))
      .not.toBe(JSON.stringify(cmd.args[0][key]))
    expect(reviewShapeHash(patched, V)).not.toBe(base)
  })

  it('help 是纯展示,不改变 reviewShapeHash', () => {
    const cmd = find('antigravity/recent-paths')
    const base = reviewShapeHash(cmd, V)
    expect(reviewShapeHash({ ...cmd, args: [{ ...cmd.args[0], help: 'CHANGED' }] }, V)).toBe(base)
  })

  it('位置参数顺序是语义;flag 顺序不是', () => {
    const cmd = {
      command: 'x/y', access: 'read', strategy: 'local', browser: false, columns: [],
      args: [
        { name: 'p1', positional: true }, { name: 'p2', positional: true },
        { name: 'f1' }, { name: 'f2' },
      ],
    }
    const swapPositional = { ...cmd, args: [cmd.args[1], cmd.args[0], cmd.args[2], cmd.args[3]] }
    const swapFlags = { ...cmd, args: [cmd.args[0], cmd.args[1], cmd.args[3], cmd.args[2]] }
    expect(reviewShapeHash(swapPositional, V)).not.toBe(reviewShapeHash(cmd, V))
    expect(reviewShapeHash(swapFlags, V)).toBe(reviewShapeHash(cmd, V))
  })

  it('三条审定记录的 reviewedAgainst 已回填为真实哈希', () => {
    for (const [key, record] of REVIEWED_RECORDS) {
      expect(record.reviewedAgainst, `${key} 未回填`).toBe(reviewShapeHash(find(key), V))
    }
  })
})

describe('decisionFingerprint', () => {
  it('metadata 变化 → 确认失效;无关 deny 变化 → 不失效', () => {
    const base = { policySchemaVersion: 1, reviewShapeHash: 'S', metadata: { exposure: 'public' }, matchedDenyRule: null }
    expect(decisionFingerprint({ ...base, metadata: { exposure: 'personal' } })).not.toBe(decisionFingerprint(base))
    // 该命令没命中任何 deny 规则,别的命令的 deny 怎么改都与它无关
    expect(decisionFingerprint({ ...base })).toBe(decisionFingerprint(base))
  })
})

describe('canonicalJson', () => {
  it('对象键顺序不影响结果,数组顺序影响', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })
})
