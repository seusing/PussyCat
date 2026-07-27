// 策略轴的取值域。**只有 exposure 与 residues 有 unknown 成员**——这两轴最常出现
// 「看了但拿不准」;其余轴没有 unknown,审定不完整时整条记录作废(spec §3.1)。
export const EXECUTION_PATHS = ['direct-node', 'browser-bridge']
export const AUTHORITIES = [
  'public-network', 'explicit-local-input', 'ambient-local-files',
  'live-local-app', 'browser-profile',
]
export const EXPOSURES = ['public', 'personal', 'secret', 'unknown']
export const EFFECTS = ['local-file-write', 'remote-write']
export const CREDENTIAL_FLOWS = ['none', 'consume', 'produce', 'both']
export const RESIDUES = ['temp-file', 'persistent-session']

function isSubsetOf(value, domain) {
  return Array.isArray(value) && value.every((item) => domain.includes(item))
}

/**
 * 审定记录是否完整。**半份记录不得参与判决**——宁可整条作废走 fail-closed,
 * 也不能拿「填了一半的分类」去过 tier 阈值。
 */
export function isCompleteRecord(record) {
  if (!record || typeof record !== 'object') return false
  if (typeof record.reviewedAgainst !== 'string') return false
  const m = record.metadata
  if (!m || typeof m !== 'object') return false
  if (!EXECUTION_PATHS.includes(m.executionPath)) return false
  if (!isSubsetOf(m.authorities, AUTHORITIES)) return false
  if (!EXPOSURES.includes(m.exposure)) return false
  if (!isSubsetOf(m.effects, EFFECTS)) return false
  if (!CREDENTIAL_FLOWS.includes(m.credentialFlow)) return false
  if (m.residues !== 'unknown' && !isSubsetOf(m.residues, RESIDUES)) return false
  return true
}
