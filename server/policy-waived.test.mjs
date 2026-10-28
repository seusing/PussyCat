// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stripBom } from '../src/shared/normalize.mjs'
import { buildPolicyDecisions } from './policy.mjs'
import { ACKNOWLEDGEMENT_WAIVED, BROWSER_COOKIE_READ_PILOT, REVIEWED_RECORDS } from './policy-metadata.mjs'

// 四条 whoami 免确认(2026-10-28 用户决定登录检查不再逐站确认)。免确认只发生在算法第 8.5 步:
// 前 7 步(deny、tier、审定完整性、审定未过期、unknown、阈值)都得先过。
const snapshot = JSON.parse(stripBom(readFileSync(resolve('public/catalog.snapshot.json'), 'utf8')))
const WHOAMI = ['xiaohongshu/whoami', 'bilibili/whoami', 'twitter/whoami', 'youtube/whoami']
const decide = (options, patch = (c) => c, version = snapshot.opencliVersion) => new Map(
  buildPolicyDecisions({ ...snapshot, opencliVersion: version, commands: snapshot.commands.map(patch) }, options)
    .map((d) => [d.commandKey, d]),
)
const recordOf = (key, patch = {}) => {
  const base = REVIEWED_RECORDS.get(key)
  return { reviewedAgainst: base.reviewedAgainst, reviewedCarry: base.reviewedCarry, metadata: { ...base.metadata, ...patch } }
}

describe('免确认成员集', () => {
  it('恰好是四条 whoami,且都在试点里', () => {
    expect([...ACKNOWLEDGEMENT_WAIVED].sort()).toEqual([...WHOAMI].sort())
    for (const key of ACKNOWLEDGEMENT_WAIVED) expect(BROWSER_COOKIE_READ_PILOT.has(key), key).toBe(true)
  })
})

describe('免确认的判决', () => {
  const decisions = decide()

  it.each(WHOAMI)('%s → ready,形状与其它 ready 判决一致', (key) => {
    const d = decisions.get(key)
    expect(d).toMatchObject({ commandKey: key, state: 'ready', decisionSource: 'tier-evaluation' })
    expect(d.reasonCode).toBeUndefined()
    expect(d.fingerprint).toEqual(expect.any(String))
  })

  it('metadata 如实保留:browser-profile、personal、持久会话残留都照旧', () => {
    for (const key of WHOAMI) {
      expect(decisions.get(key).metadata, key).toMatchObject({
        authorities: ['browser-profile', 'public-network'],
        exposure: 'personal',
        residues: ['persistent-session'],
      })
    }
  })

  it('其余十一条试点命令仍是 acknowledgement-required', () => {
    const others = [...BROWSER_COOKIE_READ_PILOT].filter((key) => !WHOAMI.includes(key))
    expect(others).toHaveLength(11)
    for (const key of others) expect(decisions.get(key).state, key).toBe('acknowledgement-required')
  })

  it('换 OpenCLI 版本、参数没变:仍然免确认,fingerprint 随版本变', () => {
    const upgraded = decide(undefined, (c) => c, '2.0.2')
    for (const key of WHOAMI) {
      expect(upgraded.get(key).state, key).toBe('ready')
      expect(upgraded.get(key).fingerprint, key).not.toBe(decisions.get(key).fingerprint)
    }
  })
})

describe('免确认绕不过前 7 步', () => {
  const KEY = 'xiaohongshu/whoami'

  it('显式 deny 仍是 denied(第 1 步)', () => {
    // COMMAND_POLICY_OVERRIDES 里只有 paperreview/review;把它放进免确认集合也不能放行
    const d = decide({ waived: new Set(['paperreview/review']) }).get('paperreview/review')
    expect(d).toMatchObject({ state: 'denied', decisionSource: 'explicit-deny', reasonCode: 'explicit-deny' })
  })

  it('不在任何 tier 里的命令放进集合也是 unknown/no-tier(第 3 步)', () => {
    const d = decide({ waived: new Set(['bilibili/history']) }).get('bilibili/history')
    expect(d).toMatchObject({ state: 'unknown', reasonCode: 'no-tier' })
  })

  it('审定记录不完整 → unknown/metadata-missing(第 4 步)', () => {
    const records = new Map([[KEY, { reviewedAgainst: REVIEWED_RECORDS.get(KEY).reviewedAgainst }]])
    expect(decide({ records }).get(KEY)).toMatchObject({ state: 'unknown', reasonCode: 'metadata-missing' })
    const halfMetadata = new Map([[KEY, { ...recordOf(KEY), metadata: { executionPath: 'browser-bridge' } }]])
    expect(decide({ records: halfMetadata }).get(KEY)).toMatchObject({ state: 'unknown', reasonCode: 'metadata-missing' })
  })

  it('没有审定记录 → unknown/metadata-missing(第 4 步)', () => {
    expect(decide({ records: new Map() }).get(KEY)).toMatchObject({ state: 'unknown', reasonCode: 'metadata-missing' })
  })

  it('审定过期 → unknown/review-stale(第 5 步):同版本参数变了、换版本参数变了都是', () => {
    const addArg = (c) => (c.command === KEY ? { ...c, args: [...c.args, { name: 'extra', type: 'str' }] } : c)
    expect(decide(undefined, addArg).get(KEY)).toMatchObject({ state: 'unknown', reasonCode: 'review-stale' })
    expect(decide(undefined, addArg, '2.0.2').get(KEY)).toMatchObject({ state: 'unknown', reasonCode: 'review-stale' })
    const moveDomain = (c) => (c.command === KEY ? { ...c, domain: 'evil.example' } : c)
    expect(decide(undefined, moveDomain, '2.0.2').get(KEY)).toMatchObject({ state: 'unknown', reasonCode: 'review-stale' })
  })

  it('exposure / residues 记为 unknown → unknown(第 6 步)', () => {
    expect(decide({ records: new Map([[KEY, recordOf(KEY, { exposure: 'unknown' })]]) }).get(KEY))
      .toMatchObject({ state: 'unknown', reasonCode: 'exposure-unknown' })
    expect(decide({ records: new Map([[KEY, recordOf(KEY, { residues: 'unknown' })]]) }).get(KEY))
      .toMatchObject({ state: 'unknown', reasonCode: 'residue-unknown' })
  })

  it('超出 tier 阈值 → denied/tier-threshold(第 7 步)', () => {
    for (const patch of [{ effects: ['remote-write'] }, { exposure: 'secret' }, { residues: ['temp-file'] }, { credentialFlow: 'produce' }]) {
      expect(decide({ records: new Map([[KEY, recordOf(KEY, patch)]]) }).get(KEY), JSON.stringify(patch))
        .toMatchObject({ state: 'denied', reasonCode: 'tier-threshold' })
    }
  })

  it('集合是可注入的:空集时 whoami 回到需确认', () => {
    const d = decide({ waived: new Set() }).get(KEY)
    expect(d.state).toBe('acknowledgement-required')
  })
})
