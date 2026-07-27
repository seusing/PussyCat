// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  isCompleteRecord,
  EXECUTION_PATHS,
  AUTHORITIES,
  EXPOSURES,
  EFFECTS,
  CREDENTIAL_FLOWS,
  RESIDUES,
} from './policy-types.mjs'
import { REVIEWED_RECORDS } from './policy-metadata.mjs'

// 合法基线夹具:每条反例只改动其中一个字段,其余五个保持合法 ——
// 避免重蹈旧测试的坑(两条反例都在 authorities 那步短路,从未走到后面的检查)。
const validMetadata = {
  executionPath: 'direct-node',
  authorities: ['ambient-local-files'],
  exposure: 'personal',
  effects: [],
  credentialFlow: 'none',
  residues: [],
}

describe('策略类型与审定记录', () => {
  it('三条代表命令都有完整审定记录', () => {
    for (const key of ['trae-cn/setup', 'mercury/reimbursement-plan', 'antigravity/recent-paths']) {
      const record = REVIEWED_RECORDS.get(key)
      expect(record, `${key} 缺审定记录`).toBeDefined()
      expect(isCompleteRecord(record), `${key} 记录不完整`).toBe(true)
    }
  })

  it('trae-cn/setup 的 authorities 是空集 —— 它只打印本地说明文本,不访问网络', () => {
    expect(REVIEWED_RECORDS.get('trae-cn/setup').metadata.authorities).toEqual([])
  })

  it('半份记录判为不完整 —— 不允许用它参与判决', () => {
    // exposure 与 residues 有 unknown 成员;其余轴没有,缺失即整条作废
    const half = { reviewedAgainst: 'x', metadata: { executionPath: 'direct-node', exposure: 'public' } }
    expect(isCompleteRecord(half)).toBe(false)
  })

  it('轴取值超出枚举即不完整', () => {
    const bad = {
      reviewedAgainst: 'x',
      metadata: {
        executionPath: 'direct-node', authorities: ['made-up'], exposure: 'public',
        effects: [], credentialFlow: 'none', residues: [],
      },
    }
    expect(isCompleteRecord(bad)).toBe(false)
    expect(AUTHORITIES).not.toContain('made-up')
    expect(EXPOSURES).toContain('unknown')
  })

  it('executionPath 非法即不完整 —— 其余五轴合法,单独守住这一行', () => {
    const bad = { reviewedAgainst: 'x', metadata: { ...validMetadata, executionPath: 'made-up-path' } }
    expect(isCompleteRecord(bad)).toBe(false)
  })

  it('exposure 非法即不完整 —— 其余五轴合法,单独守住这一行', () => {
    const bad = { reviewedAgainst: 'x', metadata: { ...validMetadata, exposure: 'ultra-secret' } }
    expect(isCompleteRecord(bad)).toBe(false)
  })

  it('effects 含非法成员即不完整 —— 其余五轴合法,单独守住这一行', () => {
    const bad = { reviewedAgainst: 'x', metadata: { ...validMetadata, effects: ['nuke'] } }
    expect(isCompleteRecord(bad)).toBe(false)
  })

  it('credentialFlow 非法即不完整 —— 其余五轴合法,单独守住这一行', () => {
    const bad = { reviewedAgainst: 'x', metadata: { ...validMetadata, credentialFlow: 'sideways' } }
    expect(isCompleteRecord(bad)).toBe(false)
  })

  it('residues 含非法成员即不完整 —— 其余五轴合法,单独守住这一行', () => {
    const bad = { reviewedAgainst: 'x', metadata: { ...validMetadata, residues: ['ghost'] } }
    expect(isCompleteRecord(bad)).toBe(false)
  })

  it('residues 为字符串哨兵值 "unknown" 时判为完整 —— spec 明文允许的例外(注意是字符串本身,不是数组)', () => {
    const good = { reviewedAgainst: 'x', metadata: { ...validMetadata, residues: 'unknown' } }
    expect(isCompleteRecord(good)).toBe(true)
  })

  it('纯继承属性的记录判为不完整 —— 必须是自有属性,原型链上的值不算数', () => {
    const inherited = Object.create({ reviewedAgainst: 'x', metadata: validMetadata })
    expect(isCompleteRecord(inherited)).toBe(false)
  })

  it('导出的枚举数组被冻结 —— push 不生效(ESM 严格模式下对冻结数组 push 会抛)', () => {
    expect(() => EXECUTION_PATHS.push('made-up-path')).toThrow()
    expect(() => AUTHORITIES.push('made-up')).toThrow()
    expect(() => EXPOSURES.push('ultra-secret')).toThrow()
    expect(() => EFFECTS.push('nuke')).toThrow()
    expect(() => CREDENTIAL_FLOWS.push('sideways')).toThrow()
    expect(() => RESIDUES.push('ghost')).toThrow()
  })
})
