// @vitest-environment node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reviewShapeHash, decisionFingerprint, canonicalJson, POLICY_SCHEMA_VERSION } from './policy-fingerprint.mjs'
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

  // 上面那条只验证了"同一个桶内两个 arg 换序"。这条补的是另一半:**单个 arg 的
  // positional 从 false 翻到 true 导致它换桶**(从 flagArgs 挪到 positionalArgs)。
  // 功能本身一直是对的(桶分流承载了这个语义),这里补的是曾经存在、后来在
  // for 循环改 it.each 时静默丢失、也没有等价替代的测试覆盖。
  it('单个 arg 的 positional 从 false 翻到 true 导致换桶,reviewShapeHash 必变', () => {
    const cmd = find('antigravity/recent-paths')
    const base = reviewShapeHash(cmd, V)
    // 先证明这确实是一次真翻转:fixture 里的原值是 false
    expect(cmd.args[0].positional).toBe(false)
    const patched = { ...cmd, args: [{ ...cmd.args[0], positional: true }] }
    expect(reviewShapeHash(patched, V)).not.toBe(base)
  })

  it('三条审定记录的 reviewedAgainst 已回填为真实哈希', () => {
    for (const [key, record] of REVIEWED_RECORDS) {
      expect(record.reviewedAgainst, `${key} 未回填`).toBe(reviewShapeHash(find(key), V))
    }
  })
})

describe('decisionFingerprint', () => {
  it('metadata 变化 → 确认失效;相同输入两次独立调用结果一致(纯函数,按值不按引用)', () => {
    const base = { policySchemaVersion: 1, reviewShapeHash: 'S', metadata: { exposure: 'public' }, matchedDenyRule: null }
    expect(decisionFingerprint({ ...base, metadata: { exposure: 'personal' } })).not.toBe(decisionFingerprint(base))
    // 注意实际验证边界:这条只证明"同一份数据,两次独立构造的对象字面量"产出同一指纹
    // (纯函数、按值不按引用比较),不是"改了另一个命令的 deny 规则,这条命令的指纹不受影响"——
    // 后者才是真正的跨命令隔离,本用例并未构造第二条 deny 规则去验证它。
    // 隔离性目前靠函数签名保证:decisionFingerprint 只接受单命令的 matchedDenyRule 标量,
    // 没有全局登记表入口,不存在"读到别的命令 deny"的通路——但这是签名保证,不是本用例验证的。
    // 真正的跨命令隔离测试要等 Task 4 接线、且 overrides 里有第二条 deny 规则时才能有效构造。
    expect(decisionFingerprint({ ...base })).toBe(decisionFingerprint(base))
  })

  // spec §3.1 把 authorities/effects/residues 定义为**集合**,§4.3 第 8 步明写「按值比较,
  // 非引用/非顺序」。一个字段一条用例(同 argProjection 的 it.each 惯例),避免一条内的
  // 前一个字段失败掩盖后一个字段从未被真正跑到。
  it.each([
    ['authorities', ['public-network', 'explicit-local-input'], ['explicit-local-input', 'public-network']],
    ['effects', ['local-file-write', 'remote-write'], ['remote-write', 'local-file-write']],
    ['residues', ['temp-file', 'persistent-session'], ['persistent-session', 'temp-file']],
  ])('metadata.%s 是集合,书写顺序不影响 decisionFingerprint', (field, orderA, orderB) => {
    // 先证明这确实是"同一集合、仅字面量顺序不同",不是碰巧两次都没测出差异
    expect([...orderA].sort()).toEqual([...orderB].sort())
    expect(JSON.stringify(orderA)).not.toBe(JSON.stringify(orderB))
    const a = { policySchemaVersion: 1, reviewShapeHash: 'S', matchedDenyRule: null,
      metadata: { exposure: 'public', [field]: orderA } }
    const b = { policySchemaVersion: 1, reviewShapeHash: 'S', matchedDenyRule: null,
      metadata: { exposure: 'public', [field]: orderB } }
    expect(decisionFingerprint(a)).toBe(decisionFingerprint(b))
  })

  it('residues 可能是字符串 "unknown" 而非数组 —— 归一化须原样透传,不得被当数组展开排序', () => {
    const metadata = { exposure: 'public', residues: 'unknown' }
    const base = { policySchemaVersion: 1, reviewShapeHash: 'S', matchedDenyRule: null, metadata }
    expect(() => decisionFingerprint(base)).not.toThrow()
    // 直接对照"手工构造的期望值"(用未经归一化的原始 metadata 直接算 canonicalJson),
    // 而不是"两次独立调用互相比较"——后者抓不住这类 bug:若归一化误用
    // `[...value].sort()` 漏了 Array.isArray 判断,字符串会被展开成字符数组再排序
    // ('unknown' → ['k','n','n','n','o','u','w']),不抛错、且两次调用结果依然彼此相等
    // (都被同样地腐化),纯粹"比较两次调用"抓不到;必须对照真正的期望值才能揭穿。
    const expected = createHash('sha256').update(canonicalJson({
      policySchemaVersion: 1, reviewShapeHash: 'S', metadata, matchedDenyRule: null,
    })).digest('hex')
    expect(decisionFingerprint(base)).toBe(expected)
  })

  // 上面那条的「手工期望值」是**用 `canonicalJson` 自己算的** —— 它对 `canonicalJson`
  // 的任何改动都自洽,抓不到漂移。本仓已有三个消费方(reviewShapeHash / decisionFingerprint
  // / Task 5 的 revision),改动它的动机只会变多,所以照 Task 3「固定源身份」那条的做法
  // 补一组**写死字面量**:值变了这里必须有人手动改,并解释为什么。
  //
  // 冻结值随 opencliVersion 整组变化:reviewShapeHash 含 opencliVersion(spec §4.1.2),
  // 每次升级 opencli 都要整组重算,代价是已保存的 acknowledgement 作废一次(409 fingerprint-stale)。
  // 重算前先用旧版本的 shape 复现旧冻结值,确认 canonicalJson 本身没漂。
  //
  // 漂移的后果:fingerprint 全变 → 用户已保存的 acknowledgement 被**无声**作废,
  // 全部需确认的命令重新弹窗。按 I-P5 它不是安全边界(acknowledgement 本就不是安全授权),
  // 但「无声」这一点本身要治。
  it('全部人工记录的 decisionFingerprint 冻结值(挡住 canonicalJson 的无声漂移)', () => {
    const frozen = new Map([
      ['trae-cn/setup', '3b6267e9c77868fd7b7b7b47f655c3f1a6fc58bfac04bf65cb62f0ddb9debd72'],
      ['mercury/reimbursement-plan', '3539d68bac77006fdb696428eb87e84179902ab0f7f5373f507dfe7262988b10'],
      ['antigravity/recent-paths', '77b620beb544611d6a2fb7f97010a0c09505c9a16b93745a5f1e5d48884bfa5d'],
      // browser-cookie-read-pilot 十五条(审定见 docs/specs/2026-07-30-browser-cookie-read-pilot-review.md)
      ['xiaohongshu/whoami', '50cc47e6271ff4c4301e9a2c724f84deb006173196db66c3c98630b7446259ed'],
      ['xiaohongshu/feed', '79c1582eb9e8c9f3838da803cefd3ceca3c21f965d83f4667b15bfd92540c677'],
      ['xiaohongshu/saved', 'edc77cb3ea323c3700c938e961387ce64412a1acaddbb3bca235770c5e477c82'],
      ['xiaohongshu/collections', '86db268efe6a2d33880ab34ba234f4baed6cd16cc253cb14f1a6ccfd4e0727f7'],
      ['xiaohongshu/liked', '13aa70bb578822950e62ae179494af16955d9bbb42029c99bcdc84677222f3c2'],
      ['xiaohongshu/search', 'b9881d442dc6cbe625beabba8cfe783168b55b3438fc3c63e1e9a4e3910c1dea'],
      ['xiaohongshu/user-posts', '7f3a09ea2421ad3360e0ba783be1bfdb4043dd1bae5015e11c93d14c716baa37'],
      ['xiaohongshu/note', '08c36d5238927b92123bfe3586416713dc6443668be8f8fc1285867d35681680'],
      ['xiaohongshu/comments', '6a27e6840bb1d864e057a9baaf524f0311e94de0bc8c9c655ce44be0d9034ac7'],
      ['bilibili/whoami', '04d7346d24ccd1004d75c40dc15a5a9efbba8ded13278a55343c3e329487692c'],
      ['bilibili/hot', 'a6bc803de2ab2b149cf565e84531e6757f91de3be5998747c97c4f3a90dbb191'],
      ['twitter/whoami', 'aee2d171333eb29fc5b5d8e381f59f434505b9cda6e8639c182d46eec9ba1b49'],
      ['twitter/timeline', '941d5b951e3d29dc3bb99e128191372fc28ca5f10e10149734004e7fdbf53430'],
      ['youtube/whoami', '9ba8a51c5ea84d624b8f77cc54279e82305fec8ef95cf640c8013e461316eb44'],
      ['youtube/subscriptions', 'c18ad0f50381a177a35da43cc560658b799698d7b3798c4a77f52cde8ed28224'],
    ])
    // 先证明冻结集就是 REVIEWED_RECORDS 的全部,否则将来再加记录时,
    // 这个冻结集会**静默地只覆盖一部分**。
    expect([...REVIEWED_RECORDS.keys()].sort()).toEqual([...frozen.keys()].sort())
    for (const [key, record] of REVIEWED_RECORDS) {
      expect(decisionFingerprint({
        policySchemaVersion: POLICY_SCHEMA_VERSION,
        reviewShapeHash: record.reviewedAgainst,
        metadata: record.metadata,
        matchedDenyRule: null,
      }), key).toBe(frozen.get(key))
    }
  })
})

describe('canonicalJson', () => {
  it('对象键顺序不影响结果,数组顺序影响', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })
})
