// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPolicyDecisions } from './policy.mjs'
import { reviewShapeHash } from './policy-fingerprint.mjs'

const snapshot = JSON.parse(readFileSync(resolve('public/catalog.snapshot.json'), 'utf8').replace(/^﻿/, ''))
const byKey = (decisions) => new Map(decisions.map((d) => [d.commandKey, d]))
const decisions = byKey(buildPolicyDecisions(snapshot))

describe('准入算法', () => {
  it('显式 deny 压过一切', () => {
    const d = decisions.get('paperreview/review')
    expect(d.state).toBe('denied')
    expect(d.decisionSource).toBe('explicit-deny')
    expect(d.reasonCode).toBe('explicit-deny')
  })

  it('legacy 基线命中 → ready,且不下发 metadata/fingerprint', () => {
    const d = decisions.get('36kr/news')
    expect(d.state).toBe('ready')
    expect(d.decisionSource).toBe('legacy-baseline')
    expect(d.metadata).toBeUndefined()
    expect(d.fingerprint).toBeUndefined()
  })

  it('三条审定命令进 tier-evaluation', () => {
    expect(decisions.get('trae-cn/setup').decisionSource).toBe('tier-evaluation')
    expect(decisions.get('trae-cn/setup').state).toBe('ready')
    expect(decisions.get('mercury/reimbursement-plan').state).toBe('ready')       // 第 8 步:显式输入
    expect(decisions.get('antigravity/recent-paths').state).toBe('acknowledgement-required')
    expect(decisions.get('antigravity/recent-paths').fingerprint).toEqual(expect.any(String))
  })

  it('local tier 内未审定的命令 → unknown/metadata-missing', () => {
    const d = decisions.get('trae-solo/state-get')
    expect(d.state).toBe('unknown')
    expect(d.decisionSource).toBe('unclassified')
    expect(d.reasonCode).toBe('metadata-missing')
  })

  it('不在任何 tier 且不在 legacy → unknown/no-tier', () => {
    const d = decisions.get('xiaohongshu/login')     // write+cookie+browser
    expect(d.state).toBe('unknown')
    expect(d.reasonCode).toBe('no-tier')
  })

  it('legacy 形状漂移 → 退出基线', () => {
    const drifted = { ...snapshot, commands: snapshot.commands.map((c) =>
      c.command === '36kr/news' ? { ...c, args: [...(c.args ?? []), { name: 'injected' }] } : c) }
    const d = byKey(buildPolicyDecisions(drifted)).get('36kr/news')
    expect(d.decisionSource).not.toBe('legacy-baseline')
    expect(d.state).toBe('unknown')
  })

  it('审定过期(reviewShapeHash 变) → unknown/review-stale,而非仅要求重确认', () => {
    const drifted = { ...snapshot, commands: snapshot.commands.map((c) =>
      c.command === 'antigravity/recent-paths' ? { ...c, modulePath: 'other.js' } : c) }
    const d = byKey(buildPolicyDecisions(drifted)).get('antigravity/recent-paths')
    expect(d.state).toBe('unknown')
    expect(d.reasonCode).toBe('review-stale')
  })

  it('每条 decision 的必填性随 state 成立(全状态可构造)', () => {
    for (const d of decisions.values()) {
      expect(['ready', 'acknowledgement-required', 'denied', 'unknown']).toContain(d.state)
      expect(['explicit-deny', 'legacy-baseline', 'tier-evaluation', 'unclassified']).toContain(d.decisionSource)
      if (d.state === 'acknowledgement-required') expect(typeof d.fingerprint).toBe('string')
      if (d.decisionSource === 'tier-evaluation') expect(d.metadata).toBeDefined()
      if (d.decisionSource !== 'tier-evaluation') expect(d.metadata).toBeUndefined()
    }
  })

  it('每条命令恰好一个 decision,且覆盖全目录', () => {
    expect(decisions.size).toBe(snapshot.commands.length)
  })

  it('可执行面 = legacy 276 + 三条 local-direct + 八条试点', () => {
    const runnable = [...decisions.values()].filter((d) => d.state === 'ready' || d.state === 'acknowledgement-required')
    expect(runnable.length).toBe(276 + 3 + 8)
  })

  // 上一条的「全状态」是遍历**恰好出现的**状态,证明不了四个状态都能构造出来。
  // 这条把它钉死:四个 state、四个 decisionSource 必须各自真的出现过。
  it('四个 state 与四个 decisionSource 都真的出现,而非「恰好遇到的那几个」', () => {
    expect(new Set([...decisions.values()].map((d) => d.state)))
      .toEqual(new Set(['ready', 'acknowledgement-required', 'denied', 'unknown']))
    expect(new Set([...decisions.values()].map((d) => d.decisionSource)))
      .toEqual(new Set(['explicit-deny', 'legacy-baseline', 'tier-evaluation', 'unclassified']))
  })
})

// ——— 注入夹具:覆盖真实三条记录**到不了**的算法出口 ————————————————
// 三条人工记录全部落在 local-direct 允许集内部,所以第 6 步的两个 unknown 出口、
// 第 7 步的 tier-threshold 出口(及其内部五个子条件)在真实数据下一条都走不到。
// 宿主选 trae-solo/state-get:它在 local-direct tier 内、本身未审定,不影响其它用例。
describe('准入算法 —— 真实数据到不了的出口(注入夹具)', () => {
  const HOST = 'trae-solo/state-get'
  const hostCommand = snapshot.commands.find((c) => c.command === HOST)
  const hostShape = reviewShapeHash(hostCommand, snapshot.opencliVersion)
  const BASE = {
    executionPath: 'direct-node', authorities: [], exposure: 'public',
    effects: [], credentialFlow: 'none', residues: [],
  }
  const decide = (patch) => byKey(buildPolicyDecisions(snapshot, {
    records: new Map([[HOST, { reviewedAgainst: hostShape, metadata: { ...BASE, ...patch } }]]),
  })).get(HOST)

  it('夹具本身必须能走到 tier-evaluation —— 否则下面每条都在测空气', () => {
    const d = decide({})
    expect(d.decisionSource).toBe('tier-evaluation')
    expect(d.state).toBe('ready')
  })

  it('authorities 按**集合**比较 —— 重复项不改变第 8 步判定(§4.3 字面)', () => {
    // 旧 sameSet 先比 length,等价于**多重集**相等:['x','x'] 与 ['x'] 判不等,
    // 于是会掉到第 9 步多挂一次弹窗。方向 fail-safe,但与 §4.3 第 8 步
    // 「authorities 集合恰好等于 {explicit-local-input}」的字面不符。
    const d = decide({ authorities: ['explicit-local-input', 'explicit-local-input'] })
    expect(d.state).toBe('ready')
    expect(d.decisionSource).toBe('tier-evaluation')
  })

  it.each([
    ['exposure=unknown 早于阈值判定', { exposure: 'unknown' }, 'unknown', 'exposure-unknown'],
    ['residues=unknown 早于阈值判定', { residues: 'unknown' }, 'unknown', 'residue-unknown'],
    ['authorities 越界', { authorities: ['live-local-app'] }, 'denied', 'tier-threshold'],
    ['exposure 越界', { exposure: 'secret' }, 'denied', 'tier-threshold'],
    ['effects 非空', { effects: ['local-file-write'] }, 'denied', 'tier-threshold'],
    ['credentialFlow 非 none', { credentialFlow: 'consume' }, 'denied', 'tier-threshold'],
    ['residues 非空', { residues: ['temp-file'] }, 'denied', 'tier-threshold'],
  ])('%s → %s/%s', (_name, patch, state, reasonCode) => {
    const d = decide(patch)
    expect(d.state).toBe(state)
    expect(d.reasonCode).toBe(reasonCode)
  })
})

// ——— browser-cookie-read-pilot 试点 ————————————————————————————————————————
// 审定见 docs/specs/2026-07-30-browser-cookie-read-pilot-review.md。
// 这一组守的是三件事:八条真的进了 tier 且只能落 ready/ack;**没进试点的同 cohort 命令
// 一条都没被带出来**;write/ui/intercept/download/login 继续被拒。
describe('browser-cookie-read-pilot', () => {
  const PILOT = [
    'xiaohongshu/whoami', 'xiaohongshu/feed',
    'bilibili/whoami', 'bilibili/hot',
    'twitter/whoami', 'twitter/timeline',
    'youtube/whoami', 'youtube/subscriptions',
  ]

  // 逐条一个用例(不塞进单个 for 循环):循环里第一条 expect 失败即抛,后面的命令根本不会被执行,
  // 于是「某条命令判决错了」与「测试压根没跑到它」在输出上长得一模一样。
  it.each(PILOT)('%s 进 tier-evaluation 且拿到 acknowledgement-required + fingerprint', (key) => {
    const d = decisions.get(key)
    expect(d, `${key} 不在判决表里`).toBeDefined()
    expect(d.decisionSource).toBe('tier-evaluation')
    expect(d.state).toBe('acknowledgement-required')
    expect(typeof d.fingerprint).toBe('string')
    expect(d.metadata.executionPath).toBe('browser-bridge')
    expect(d.metadata.credentialFlow).toBe('consume')
  })

  it('八条只能得 ready 或 acknowledgement-required —— 不得出现 denied/unknown', () => {
    for (const key of PILOT) {
      expect(['ready', 'acknowledgement-required'], key).toContain(decisions.get(key).state)
    }
  })

  it('bilibili/hot 虽 exposure=public,仍需确认 —— 它以用户登录身份打 API', () => {
    // 这条单独立用例:它是第 9 步新增 browser-profile 分支唯一能打红的真实数据点。
    // 按扩展前的第 9 步(只看 ambient-local-files / personal),它会落第 10 步直接 ready。
    const d = decisions.get('bilibili/hot')
    expect(d.metadata.exposure).toBe('public')
    expect(d.metadata.residues).toEqual([])
    expect(d.state).toBe('acknowledgement-required')
  })

  it('四条 whoami 的 persistent-session 如实进 metadata,并随判决下发', () => {
    for (const key of ['xiaohongshu/whoami', 'bilibili/whoami', 'twitter/whoami', 'youtube/whoami']) {
      expect(decisions.get(key).metadata.residues, key).toEqual(['persistent-session'])
    }
  })

  it('**同 cohort 的非成员一条都没被带出来** —— 496 条 read+cookie+browser 里只放行这八条', () => {
    const cohort = snapshot.commands
      .filter((c) => c.access === 'read' && c.strategy === 'cookie' && c.browser === true)
      .map((c) => c.command)
    // 先证明这个 cohort 确实远大于试点,否则下面的断言可能在一个只有八条的集合上空转
    expect(cohort.length).toBeGreaterThan(400)
    const runnable = cohort.filter((k) => {
      const d = decisions.get(k)
      return d.state === 'ready' || d.state === 'acknowledgement-required'
    })
    expect(runnable.sort()).toEqual([...PILOT].sort())
  })

  it.each([
    ['bilibili/history', 'read+cookie 同站非成员'],
    ['bilibili/following', 'read+cookie 同站非成员'],
    ['xiaohongshu/comments', 'read+cookie 同站非成员'],
    ['12306/orders', 'read+cookie 他站非成员'],
  ])('%s(%s)保持 unknown/no-tier', (key) => {
    const d = decisions.get(key)
    expect(d, `${key} 不在判决表里`).toBeDefined()
    expect(d.state).toBe('unknown')
    expect(d.reasonCode).toBe('no-tier')
  })

  it.each([
    ['xiaohongshu/login', 'login(write+cookie)'],
    ['12306/login', 'login(write+cookie)'],
    ['antigravity/cookies', 'ui'],
    ['36kr/article', 'intercept'],
    ['bilibili/download', 'download'],
  ])('%s(%s)继续被拒', (key) => {
    const d = decisions.get(key)
    expect(d, `${key} 不在判决表里`).toBeDefined()
    expect(['denied', 'unknown'], key).toContain(d.state)
    expect(d.state === 'ready' || d.state === 'acknowledgement-required').toBe(false)
  })
})
