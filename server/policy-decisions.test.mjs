// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPolicyDecisions } from './policy.mjs'
import { reviewShapeHash } from './policy-fingerprint.mjs'
import { REVIEWED_RECORDS } from './policy-metadata.mjs'

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

  it('三条审定命令进 tier-evaluation', () => {
    expect(decisions.get('trae-cn/setup').decisionSource).toBe('tier-evaluation')
    expect(decisions.get('trae-cn/setup').state).toBe('ready')
    expect(decisions.get('mercury/reimbursement-plan').state).toBe('ready')
    expect(decisions.get('antigravity/recent-paths').state).toBe('ready')           // 2026-10-29 起不再要求运行前确认
    expect(decisions.get('antigravity/recent-paths').fingerprint).toEqual(expect.any(String))
  })

  it('local tier 内未审定的命令 → unknown/metadata-missing', () => {
    const d = decisions.get('trae-solo/state-get')
    expect(d.state).toBe('unknown')
    expect(d.decisionSource).toBe('unclassified')
    expect(d.reasonCode).toBe('metadata-missing')
  })

  it('不在任何 tier → unknown/no-tier', () => {
    const d = decisions.get('xiaohongshu/login')     // write+cookie+browser
    expect(d.state).toBe('unknown')
    expect(d.reasonCode).toBe('no-tier')
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
      expect(['explicit-deny', 'tier-evaluation', 'unclassified']).toContain(d.decisionSource)
      if (d.state === 'acknowledgement-required') expect(typeof d.fingerprint).toBe('string')
      if (d.decisionSource === 'tier-evaluation') expect(d.metadata).toBeDefined()
      if (d.decisionSource !== 'tier-evaluation') expect(d.metadata).toBeUndefined()
    }
  })

  it('每条命令恰好一个 decision,且覆盖全目录', () => {
    expect(decisions.size).toBe(snapshot.commands.length)
  })

  it('可执行面 = 三条 local-direct + 十五条试点,且全部是 ready', () => {
    const runnable = [...decisions.values()].filter((d) => d.state === 'ready' || d.state === 'acknowledgement-required')
    expect(runnable.length).toBe(3 + 15)
    expect(runnable.every((d) => d.state === 'ready')).toBe(true)
  })

  // 上一条的「全状态」是遍历**恰好出现的**状态,证明不了各状态都能构造出来。
  // 这条把它钉死:现行策略会产生的三个 state、三个 decisionSource 必须各自真的出现过;
  // acknowledgement-required 自 2026-10-29 起不再产生(协议仍定义它)。
  it('三个 state 与三个 decisionSource 都真的出现,而非「恰好遇到的那几个」', () => {
    expect(new Set([...decisions.values()].map((d) => d.state)))
      .toEqual(new Set(['ready', 'denied', 'unknown']))
    expect(new Set([...decisions.values()].map((d) => d.decisionSource)))
      .toEqual(new Set(['explicit-deny', 'tier-evaluation', 'unclassified']))
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
  // 这一组守的是三件事:十五条真的进了 tier 且只能落 ready;**没进试点的同 cohort 命令
// 一条都没被带出来**;write/ui/intercept/download/login 继续被拒。
describe('browser-cookie-read-pilot', () => {
  const PILOT = [
    'xiaohongshu/whoami', 'xiaohongshu/feed', 'xiaohongshu/saved', 'xiaohongshu/collections', 'xiaohongshu/liked',
    'xiaohongshu/search', 'xiaohongshu/user-posts', 'xiaohongshu/note', 'xiaohongshu/comments',
    'bilibili/whoami', 'bilibili/hot',
    'twitter/whoami', 'twitter/timeline',
    'youtube/whoami', 'youtube/subscriptions',
  ]

  // 逐条一个用例(不塞进单个 for 循环):循环里第一条 expect 失败即抛,后面的命令根本不会被执行,
  // 于是「某条命令判决错了」与「测试压根没跑到它」在输出上长得一模一样。
  // 2026-10-29 起运行前不再确认:十五条一律 ready,fingerprint 与 metadata 照常下发。
  it.each(PILOT)('%s 进 tier-evaluation 且 ready,metadata 与 fingerprint 照常下发', (key) => {
    const d = decisions.get(key)
    expect(d, `${key} 不在判决表里`).toBeDefined()
    expect(d.decisionSource).toBe('tier-evaluation')
    expect(d.state).toBe('ready')
    expect(typeof d.fingerprint).toBe('string')
    expect(d.metadata.executionPath).toBe('browser-bridge')
    expect(d.metadata.credentialFlow).toBe('consume')
  })

  it('十五条只能得 ready —— 不得出现 denied/unknown/acknowledgement-required', () => {
    for (const key of PILOT) {
      expect(decisions.get(key).state, key).toBe('ready')
    }
  })

  it('审定记录里的风险面照旧如实下发:browser-profile 与 personal / persistent-session 不因免确认而改写', () => {
    for (const key of PILOT) {
      expect(decisions.get(key).metadata.authorities, key).toContain('browser-profile')
    }
    expect(decisions.get('xiaohongshu/feed').metadata.exposure).toBe('personal')
    expect(decisions.get('bilibili/hot').metadata.exposure).toBe('public')
  })

  it('xiaohongshu/search、note、comments 读的是他人公开笔记,exposure 为 public', () => {
    for (const key of ['xiaohongshu/search', 'xiaohongshu/note', 'xiaohongshu/comments']) {
      expect(decisions.get(key).metadata.exposure, key).toBe('public')
    }
  })

  it('四条 whoami 的 persistent-session 如实进 metadata,并随判决下发', () => {
    for (const key of ['xiaohongshu/whoami', 'bilibili/whoami', 'twitter/whoami', 'youtube/whoami']) {
      expect(decisions.get(key).metadata.residues, key).toEqual(['persistent-session'])
    }
  })

  it('**同 cohort 的非成员一条都没被带出来** —— read+cookie+browser 里只放行这十五条', () => {
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
    ['xiaohongshu/download', 'read+cookie 同站非成员(会写本地文件)'],
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

// ——— 通过前 7 步才 ready ——————————————————————————————————————————————
// 2026-10-29 起运行前不再确认:通过显式 deny、tier、审定完整性、审定未过期、unknown、阈值之后一律 ready,
// 与 authorities / exposure / residues 无关。这一组守的是「ready 不会绕过前 7 步」:
// 任何一步没过,都还是 denied/unknown,不会因为取消确认而被放行。
describe('一律 ready 不绕过前 7 步(试点命令,注入夹具)', () => {
  const KEY = 'xiaohongshu/feed'
  const baseRecord = REVIEWED_RECORDS.get(KEY)
  const recordWith = (patch) => new Map([[KEY, {
    reviewedAgainst: baseRecord.reviewedAgainst,
    reviewedCarry: baseRecord.reviewedCarry,
    metadata: { ...baseRecord.metadata, ...patch },
  }]])
  const decide = ({ records, patch = (c) => c, version = snapshot.opencliVersion } = {}) => byKey(buildPolicyDecisions(
    { ...snapshot, opencliVersion: version, commands: snapshot.commands.map(patch) },
    records ? { records } : undefined,
  )).get(KEY)

  it('夹具本身走得到 tier-evaluation 的 ready', () => {
    expect(decide()).toMatchObject({ state: 'ready', decisionSource: 'tier-evaluation' })
  })

  it.each([
    ['browser-profile + personal + persistent-session', { exposure: 'personal', residues: ['persistent-session'] }],
    ['public-network 且 public', { authorities: ['public-network'], exposure: 'public' }],
    ['credentialFlow=none', { credentialFlow: 'none' }],
  ])('通过前 7 步的记录(%s)→ ready', (_name, patch) => {
    expect(decide({ records: recordWith(patch) })).toMatchObject({ state: 'ready', decisionSource: 'tier-evaluation' })
  })

  it('没有审定记录 / 记录不完整 → unknown/metadata-missing(第 4 步)', () => {
    expect(decide({ records: new Map() })).toMatchObject({ state: 'unknown', reasonCode: 'metadata-missing' })
    const half = new Map([[KEY, { reviewedAgainst: baseRecord.reviewedAgainst, metadata: { executionPath: 'browser-bridge' } }]])
    expect(decide({ records: half })).toMatchObject({ state: 'unknown', reasonCode: 'metadata-missing' })
  })

  it('审定过期 → unknown/review-stale(第 5 步):同版本和换版本、参数和 domain 变了都是', () => {
    const addArg = (c) => (c.command === KEY ? { ...c, args: [...c.args, { name: 'extra', type: 'str' }] } : c)
    const moveDomain = (c) => (c.command === KEY ? { ...c, domain: 'evil.example' } : c)
    expect(decide({ patch: addArg })).toMatchObject({ state: 'unknown', reasonCode: 'review-stale' })
    expect(decide({ patch: addArg, version: '2.0.2' })).toMatchObject({ state: 'unknown', reasonCode: 'review-stale' })
    expect(decide({ patch: moveDomain, version: '2.0.2' })).toMatchObject({ state: 'unknown', reasonCode: 'review-stale' })
  })

  it('exposure / residues 记为 unknown → unknown(第 6 步)', () => {
    expect(decide({ records: recordWith({ exposure: 'unknown' }) })).toMatchObject({ state: 'unknown', reasonCode: 'exposure-unknown' })
    expect(decide({ records: recordWith({ residues: 'unknown' }) })).toMatchObject({ state: 'unknown', reasonCode: 'residue-unknown' })
  })

  it.each([
    ['effects 非空', { effects: ['remote-write'] }],
    ['exposure=secret', { exposure: 'secret' }],
    ['residues 含 temp-file', { residues: ['temp-file'] }],
    ['credentialFlow=produce', { credentialFlow: 'produce' }],
    ['authorities 越界', { authorities: ['live-local-app'] }],
  ])('超出 tier 阈值(%s)→ denied/tier-threshold(第 7 步)', (_name, patch) => {
    expect(decide({ records: recordWith(patch) })).toMatchObject({ state: 'denied', reasonCode: 'tier-threshold' })
  })

  it('不在任何 tier 里 → unknown/no-tier(第 3 步)', () => {
    expect(decisions.get('bilibili/history')).toMatchObject({ state: 'unknown', reasonCode: 'no-tier' })
  })

  it('local-direct 里读本地文件、personal 的命令同样直接 ready', () => {
    const host = 'trae-solo/state-get'
    const hostCommand = snapshot.commands.find((c) => c.command === host)
    const records = new Map([[host, {
      reviewedAgainst: reviewShapeHash(hostCommand, snapshot.opencliVersion),
      metadata: { executionPath: 'direct-node', authorities: ['ambient-local-files'], exposure: 'personal', effects: [], credentialFlow: 'none', residues: [] },
    }]])
    const d = byKey(buildPolicyDecisions(snapshot, { records })).get(host)
    expect(d).toMatchObject({ state: 'ready', decisionSource: 'tier-evaluation' })
    expect(d.metadata.authorities).toEqual(['ambient-local-files'])
  })
})
