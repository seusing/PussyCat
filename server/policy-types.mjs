// 策略轴的取值域。**只有 exposure 与 residues 有 unknown 成员**——这两轴最常出现
// 「看了但拿不准」;其余轴没有 unknown,审定不完整时整条记录作废(spec §3.1)。
// Object.freeze:这六个数组是 ESM 单例,进程内所有 import 者共享同一份引用——
// 不冻结的话,任何一个消费方 push 一下就会污染全局取值域。
export const EXECUTION_PATHS = Object.freeze(['direct-node', 'browser-bridge'])
export const AUTHORITIES = Object.freeze([
  'public-network', 'explicit-local-input', 'ambient-local-files',
  'live-local-app', 'browser-profile',
])
export const EXPOSURES = Object.freeze(['public', 'personal', 'secret', 'unknown'])
export const EFFECTS = Object.freeze(['local-file-write', 'remote-write'])
export const CREDENTIAL_FLOWS = Object.freeze(['none', 'consume', 'produce', 'both'])
export const RESIDUES = Object.freeze(['temp-file', 'persistent-session'])

function isSubsetOf(value, domain) {
  return Array.isArray(value) && value.every((item) => domain.includes(item))
}

/**
 * 审定记录是否完整。**半份记录不得参与判决**——宁可整条作废走 fail-closed,
 * 也不能拿「填了一半的分类」去过 tier 阈值。
 *
 * 用 Object.hasOwn 做自有属性检查:纯靠原型链继承来的字段不算数,
 * 否则 Object.create({reviewedAgainst:'x', metadata:<合法值>}) 这种
 * 自身属性全空、全靠继承的对象会被误判为完整记录。
 */
export function isCompleteRecord(record) {
  if (!record || typeof record !== 'object') return false
  if (!Object.hasOwn(record, 'reviewedAgainst') || typeof record.reviewedAgainst !== 'string') return false
  if (!Object.hasOwn(record, 'metadata')) return false
  const m = record.metadata
  if (!m || typeof m !== 'object') return false
  if (!Object.hasOwn(m, 'executionPath') || !EXECUTION_PATHS.includes(m.executionPath)) return false
  if (!Object.hasOwn(m, 'authorities') || !isSubsetOf(m.authorities, AUTHORITIES)) return false
  if (!Object.hasOwn(m, 'exposure') || !EXPOSURES.includes(m.exposure)) return false
  if (!Object.hasOwn(m, 'effects') || !isSubsetOf(m.effects, EFFECTS)) return false
  if (!Object.hasOwn(m, 'credentialFlow') || !CREDENTIAL_FLOWS.includes(m.credentialFlow)) return false
  if (!Object.hasOwn(m, 'residues') || (m.residues !== 'unknown' && !isSubsetOf(m.residues, RESIDUES))) return false
  return true
}
