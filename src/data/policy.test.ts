import { explainDecision, isRunnable, type PolicyDecision } from './policy'

const base = { commandKey: 'x/y' } as const

test('isRunnable: ready → true', () => {
  expect(isRunnable({ ...base, state: 'ready', decisionSource: 'legacy-baseline' })).toBe(true)
})
test('isRunnable: acknowledgement-required → true', () => {
  expect(isRunnable({ ...base, state: 'acknowledgement-required', decisionSource: 'tier-evaluation' })).toBe(true)
})
test('isRunnable: denied → false', () => {
  expect(isRunnable({ ...base, state: 'denied', decisionSource: 'explicit-deny' })).toBe(false)
})
test('isRunnable: unknown → false', () => {
  expect(isRunnable({ ...base, state: 'unknown', decisionSource: 'unclassified' })).toBe(false)
})
test('isRunnable: undefined(尚无判决) → false,fail-closed(I-P2)', () => {
  expect(isRunnable(undefined)).toBe(false)
})

test('explainDecision: undefined → 尚未取得判决的文案', () => {
  expect(explainDecision(undefined)).toBe('尚未取得该命令的策略判决')
})
test('explainDecision: 显式 reason 优先于 reasonCode 映射', () => {
  const d: PolicyDecision = { ...base, state: 'denied', decisionSource: 'explicit-deny', reasonCode: 'explicit-deny', reason: '自定义原因' }
  expect(explainDecision(d)).toBe('自定义原因')
})
test.each([
  ['explicit-deny', '该命令已被策略明确排除'],
  ['no-tier', '该命令尚未进入任何已开放的能力分组'],
  ['metadata-missing', '该命令还没有完成人工安全审定'],
  ['review-stale', '命令形状已变化，需要重新审定'],
  ['exposure-unknown', '输出敏感度尚未判定'],
  ['residue-unknown', '残留物尚未判定'],
  ['tier-threshold', '该命令超出当前分组允许的能力范围'],
])('explainDecision: reasonCode %s → 固定文案', (reasonCode, text) => {
  const d: PolicyDecision = { ...base, state: 'unknown', decisionSource: 'unclassified', reasonCode }
  expect(explainDecision(d)).toBe(text)
})
test('explainDecision: 未知 reasonCode → 兜底文案', () => {
  const d: PolicyDecision = { ...base, state: 'unknown', decisionSource: 'unclassified', reasonCode: 'made-up' }
  expect(explainDecision(d)).toBe('该命令当前不可执行')
})
test('explainDecision: 无 reason 也无 reasonCode → 兜底文案', () => {
  const d: PolicyDecision = { ...base, state: 'unknown', decisionSource: 'unclassified' }
  expect(explainDecision(d)).toBe('该命令当前不可执行')
})
