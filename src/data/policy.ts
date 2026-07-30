// 前端侧的判决类型。**本文件不得出现任何准入规则**——
// 「能不能跑」由 Host 决定,前端只读 state 与 reasonCode(I-P1)。
export type PolicyMetadata = {
  executionPath: 'direct-node' | 'browser-bridge'
  authorities: string[]
  exposure: 'public' | 'personal' | 'secret' | 'unknown'
  effects: string[]
  credentialFlow: 'none' | 'consume' | 'produce' | 'both'
  residues: 'unknown' | string[]
}

export type PolicyDecision = {
  commandKey: string
  state: 'ready' | 'acknowledgement-required' | 'denied' | 'unknown'
  decisionSource: 'explicit-deny' | 'legacy-baseline' | 'tier-evaluation' | 'unclassified'
  fingerprint?: string
  metadata?: PolicyMetadata
  reasonCode?: string
  reason?: string
}

const REASON_TEXT: Record<string, string> = {
  'explicit-deny': '该命令已被策略明确排除',
  'no-tier': '该命令尚未进入任何已开放的能力分组',
  'metadata-missing': '该命令还没有完成人工安全审定',
  'review-stale': '命令形状已变化，需要重新审定',
  'exposure-unknown': '输出敏感度尚未判定',
  'residue-unknown': '残留物尚未判定',
  'tier-threshold': '该命令超出当前分组允许的能力范围',
}

/** 只做文案映射,不做任何判断。 */
export function explainDecision(decision: PolicyDecision | undefined): string {
  if (!decision) return '尚未取得该命令的策略判决'
  if (decision.reason) return decision.reason
  return REASON_TEXT[decision.reasonCode ?? ''] ?? '该命令当前不可执行'
}

export function isRunnable(decision: PolicyDecision | undefined): boolean {
  return decision?.state === 'ready' || decision?.state === 'acknowledgement-required'
}
