import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCompleteRecord } from './policy-types.mjs'
import { REVIEWED_RECORDS } from './policy-metadata.mjs'
import { POLICY_SCHEMA_VERSION, decisionFingerprint, reviewShapeHash } from './policy-fingerprint.mjs'

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEGACY_BASELINE = JSON.parse(
  readFileSync(join(moduleRoot, 'server/policy-legacy-baseline.json'), 'utf8'),
)

export class RequestPolicyError extends Error {
  constructor(statusCode, message, detail) {
    super(message)
    this.name = 'RequestPolicyError'
    this.statusCode = statusCode
    this.detail = detail
  }
}

/**
 * 显式命令策略覆盖表 —— P1-B 能力模型的**第一行数据**,不是临时补丁。
 *
 * 为什么需要它:派生规则(read + public + browser=false)只看得见 catalog 明确表达的事实,
 * 表达不了「返回体里有什么」。`paperreview/review` 就是反例——它三条件全满足,
 * 但适配器 `clis/paperreview/review.js` 直接把 `token` 放进返回体、并用它拼出 `review_url`;
 * 而 `columns` 里**没有** `token`,所以「表格看不见」不等于「复制结果拿不到」。
 * 输出敏感度无法从 catalog 推断,只能显式裁决。
 *
 * **deny-only、deny 优先**:本表只做减法。不开放显式 `allow`——两种错误的代价不对称:
 * 写错一条 deny 最多让一条命令跑不了,写错一条 allow 会**扩大执行面**。
 * 能力模型成型前不接受后一种风险。
 */
export const COMMAND_POLICY_OVERRIDES = {
  'paperreview/review': {
    decision: 'deny',
    reason: '返回体包含 capability token(review.js 直接返回 token 且 review_url 内嵌它),输出面尚无分类与分发治理',
  },
}

// local-direct tier 的允许集(spec §4.1.1)。「本 tier 不接收」不等于永久排除。
const LOCAL_DIRECT = {
  authorities: ['public-network', 'explicit-local-input', 'ambient-local-files'],
  exposures: ['public', 'personal'],
}

function tierOf(command) {
  if (command.browser === false && command.strategy === 'local') return 'local-direct'
  return null
}

function withinLocalDirect(m) {
  if (!m.authorities.every((a) => LOCAL_DIRECT.authorities.includes(a))) return false
  if (!LOCAL_DIRECT.exposures.includes(m.exposure)) return false
  if (m.effects.length > 0) return false
  if (m.credentialFlow !== 'none') return false
  if (!Array.isArray(m.residues) || m.residues.length > 0) return false
  return true
}

/** 集合恰好相等(按值,非引用/非顺序)——第 8 步的判据。 */
function sameSet(a, b) {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')
}

// `records` 是**只给测试用的注入缝**,生产调用不传第二参。
// 为什么必须开这道缝:真实的三条人工记录全部落在 local-direct 允许集**内部**
// (exposure ∈ {public,personal}、effects/residues 皆 []、credentialFlow=none),
// 于是第 6 步的两个 unknown 出口、第 7 步的 tier-threshold 出口(及其内部五个子条件)
// 在真实数据下**一条都走不到**。不开缝的话这几个分支交付即死代码,
// 而且变异②(删 residues 检查)根本无从验证——删了也没有任何用例会红。
export function buildPolicyDecisions(snapshot, { records = REVIEWED_RECORDS } = {}) {
  const version = snapshot.opencliVersion
  return snapshot.commands.map((command) => {
    const commandKey = command.command
    const base = { commandKey }

    // 1. 显式 deny 优先级最高 [I-P3]
    const denyRule = COMMAND_POLICY_OVERRIDES[commandKey]
    if (denyRule?.decision === 'deny') {
      return { ...base, state: 'denied', decisionSource: 'explicit-deny',
               reasonCode: 'explicit-deny', reason: denyRule.reason }
    }

    const shape = reviewShapeHash(command, version)

    // 2. legacy 基线:命中且形状未漂移 → ready,不下发 metadata/fingerprint
    //
    // **这一行就是 legacy 完整性的第二层。** 闸门(check:legacy)只管 key 集合的增删,
    // 管不了「同一个 key 的 hash 被改成别的值」;真正兜住那一面的是这里的等值比较——
    // 入库哈希与当前形状对不上,该命令自动退出基线落入 unknown。
    // 两层缺一不可,**任何一层被当成单独兜底都是误解**(spec §4.1.2 L1 / L2)。
    if (LEGACY_BASELINE.entries[commandKey] === shape) {
      return { ...base, state: 'ready', decisionSource: 'legacy-baseline' }
    }

    // 3. tier
    if (!tierOf(command)) {
      return { ...base, state: 'unknown', decisionSource: 'unclassified', reasonCode: 'no-tier' }
    }

    // 4. 审定记录完整性
    const record = records.get(commandKey)
    if (!isCompleteRecord(record)) {
      return { ...base, state: 'unknown', decisionSource: 'unclassified', reasonCode: 'metadata-missing' }
    }

    // 5. 审定是否针对当前形状
    if (record.reviewedAgainst !== shape) {
      return { ...base, state: 'unknown', decisionSource: 'unclassified', reasonCode: 'review-stale' }
    }

    const m = record.metadata

    // 6. unknown 语义**必须早于**阈值判定——否则 exposure=unknown 会先被判成 denied
    if (m.exposure === 'unknown') {
      return { ...base, state: 'unknown', decisionSource: 'unclassified', reasonCode: 'exposure-unknown' }
    }
    if (m.residues === 'unknown') {
      return { ...base, state: 'unknown', decisionSource: 'unclassified', reasonCode: 'residue-unknown' }
    }

    // 7. tier 阈值(含 residues)
    if (!withinLocalDirect(m)) {
      return { ...base, state: 'denied', decisionSource: 'tier-evaluation',
               metadata: m, reasonCode: 'tier-threshold' }
    }

    // matchedDenyRule 在本里程碑**恒为 null**,这是算法结构决定的:命中 deny 的命令在
    // 第 1 步就 return 了,能走到这里的必然没命中任何 deny 规则。参数不是多余——它给的是
    // 「确认因该命令自己的 deny 规则变动而失效」这条语义(对照:用全局 denyRevision 会让
    // 无关命令的 deny 变动作废全部确认)。但**今天没有任何路径能让它非空**,
    // 也就没有任何测试覆盖它非空时的行为。真要用上它,得等覆盖表出现「非 deny 的规则类型」。
    const fingerprint = decisionFingerprint({
      policySchemaVersion: POLICY_SCHEMA_VERSION,
      reviewShapeHash: shape,
      metadata: m,
      matchedDenyRule: null,
    })

    // 8. 显式输入:表单已明示读取对象,选择即授权。**必须早于第 9 步**,
    //    否则 mercury(explicit-local-input + personal)会被挂上多余弹窗。
    if (sameSet(m.authorities, ['explicit-local-input'])) {
      return { ...base, state: 'ready', decisionSource: 'tier-evaluation', metadata: m, fingerprint }
    }

    // 9. 环境式本地读取 或 personal 输出 → 需确认
    if (m.authorities.includes('ambient-local-files') || m.exposure === 'personal') {
      return { ...base, state: 'acknowledgement-required', decisionSource: 'tier-evaluation', metadata: m, fingerprint }
    }

    // 10.
    return { ...base, state: 'ready', decisionSource: 'tier-evaluation', metadata: m, fingerprint }
  })
}

export function buildExecutionPolicy(snapshot) {
  if (!Array.isArray(snapshot.commands)) {
    throw new Error('Catalog snapshot has no commands array')
  }

  const decisions = buildPolicyDecisions(snapshot)
  const decisionByKey = new Map(decisions.map((d) => [d.commandKey, d]))

  // allowedCommands 改由判决派生 —— 与 decisions **单一事实源**,不再是并行的第二套规则。
  const allowedCommands = new Set(
    decisions
      .filter((d) => d.state === 'ready' || d.state === 'acknowledgement-required')
      .map((d) => d.commandKey),
  )

  const deniedCommands = new Map()
  for (const [commandKey, rule] of Object.entries(COMMAND_POLICY_OVERRIDES)) {
    if (rule?.decision !== 'deny') continue
    deniedCommands.set(commandKey, rule.reason)
  }

  return {
    opencliVersion: snapshot.opencliVersion,
    allowedCommands,
    deniedCommands,
    decisions,
    decisionByKey,
    // 措辞如实:执行面不再仅由三条件决定,还减去覆盖表。
    description: `catalog: access=read, strategy=public, browser=false;再减去覆盖表 deny ${deniedCommands.size} 条`,
  }
}

export function loadExecutionPolicy(catalogPath) {
  const snapshot = JSON.parse(readFileSync(catalogPath, 'utf8').replace(/^\uFEFF/, ''))
  return buildExecutionPolicy(snapshot)
}

function assertPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestPolicyError(400, 'Request body must be a JSON object')
  }
}

function requestedFormat(argv) {
  let format
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '-f' || token === '--format') {
      format = argv[index + 1]
      index += 1
    } else if (token.startsWith('--format=')) {
      format = token.slice('--format='.length)
    }
  }
  return format
}

export function validateStartRequest(value, policy, {
  maxArgv = 128,
  maxTokenLength = 8192,
} = {}) {
  assertPlainObject(value)
  const { runId, commandKey, argv } = value

  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) {
    throw new RequestPolicyError(400, 'Invalid runId')
  }
  if (typeof commandKey !== 'string' || !/^[^\s/]+\/[^\s/]+$/.test(commandKey)) {
    throw new RequestPolicyError(400, 'Invalid commandKey')
  }
  if (!Array.isArray(argv) || argv.length < 2 || argv.length > maxArgv) {
    throw new RequestPolicyError(400, 'argv must contain 2 to 128 tokens')
  }
  if (argv.some((token) => typeof token !== 'string' || token.length > maxTokenLength || token.includes('\0'))) {
    throw new RequestPolicyError(400, 'argv contains an invalid token')
  }

  const argvCommandKey = `${argv[0]}/${argv[1]}`
  if (commandKey !== argvCommandKey) {
    throw new RequestPolicyError(400, 'commandKey does not match argv', `${commandKey} != ${argvCommandKey}`)
  }
  if (!policy.allowedCommands.has(commandKey)) {
    // summary 保持不变(冻结契约:前端按 summary 常显 / detail 按需展开)。
    // 显式 deny 的理由进 detail —— 否则用户只看到"不在策略内",无从知道是三条件没过
    // 还是被人工裁决拿掉的,后者是可以申诉/推进的,前者不是。
    const denyReason = policy.deniedCommands?.get(commandKey)
    throw new RequestPolicyError(
      403,
      'Command is outside the P0-B execution policy',
      denyReason ? `${commandKey}: ${denyReason}` : commandKey,
    )
  }
  if (requestedFormat(argv) !== 'json') {
    throw new RequestPolicyError(400, 'P0-B requires explicit JSON output', 'append -f json to argv')
  }

  return { runId, commandKey, argv: [...argv] }
}

export function validateCancelRequest(value) {
  assertPlainObject(value)
  if (typeof value.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.runId)) {
    throw new RequestPolicyError(400, 'Invalid runId')
  }
  return { runId: value.runId }
}
