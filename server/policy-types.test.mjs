// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isCompleteRecord, AUTHORITIES, EXPOSURES } from './policy-types.mjs'
import { REVIEWED_RECORDS } from './policy-metadata.mjs'

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
})
