import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCompleteRecord } from './policy-types.mjs'
import { REVIEWED_RECORDS } from './policy-metadata.mjs'
import { POLICY_SCHEMA_VERSION, decisionFingerprint, reviewShapeHash } from './policy-fingerprint.mjs'

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// OPENCLI_HOST_LEGACY_BASELINE_PATH 是**测试注入点**(供 readiness.test.mjs 制造损坏基线),
// 与 index.mjs 的 OPENCLI_HOST_CATALOG_PATH 同一套路;默认行为不变。
const LEGACY_BASELINE_PATH = process.env.OPENCLI_HOST_LEGACY_BASELINE_PATH
  ?? join(moduleRoot, 'server/policy-legacy-baseline.json')

// 读盘**惰性 + memo**:模块求值期一律不碰磁盘。
// 理由是 readiness 失败协议(见 index.mjs 的 failReady 注释):index.mjs 的 try/catch 包住的是
// `loadExecutionPolicy`,而静态 ESM import 在 try **之前**求值 —— 若把 JSON.parse 放在模块顶层,
// 基线损坏会以**裸 SyntaxError** 抛在 module job 里,`failReady()` 从未被调用,
// supervisor 收不到 `opencliHostReady:false`,于是「协议内失败」被误判成 process-failed,
// 给用户的文案与排障方向全错。惰性化让这类损坏落进 loadExecutionPolicy 的 try,走结构化失败。
let legacyBaselineMemo = null
function legacyBaseline() {
  if (legacyBaselineMemo === null) {
    legacyBaselineMemo = JSON.parse(readFileSync(LEGACY_BASELINE_PATH, 'utf8'))
  }
  return legacyBaselineMemo
}

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
  // 走到这里 residues 必是数组:isCompleteRecord 只放行 `'unknown'` 或 RESIDUES 子集数组,
  // 而 `'unknown'` 已被第 6 步拦掉。原先这里还有一个 `!Array.isArray(m.residues)` 前置判断,
  // 已删 —— 它是**到不了的分支**,留着会让人误以为第 7 步在补防一类第 6 步漏掉的输入。
  if (m.residues.length > 0) return false
  return true
}

/**
 * 集合恰好相等(按值,非引用/非顺序、**非重数**)——第 8 步的判据。
 * 用 Set 归一化再比:spec §4.3 第 8 步说的是「authorities 集合恰好等于 {explicit-local-input}」,
 * 集合语义下 `['x','x']` 与 `['x']` 相等。旧实现先比 length,等价于**多重集**相等,
 * 于是 `['explicit-local-input','explicit-local-input']` 会掉到第 9 步多挂一次弹窗——
 * 方向是 fail-safe,但与 §4.3 字面不符。
 */
function sameSet(a, b) {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size !== right.size) return false
  for (const item of left) if (!right.has(item)) return false
  return true
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
    if (legacyBaseline().entries[commandKey] === shape) {
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
  //
  // **它是「判决可执行」的计数视图,不是准入依据。** 准入的唯一入口是
  // `decisionByKey` + `validateStartRequest`;本集合唯一的消费点是 index.mjs 的报数
  // (readiness 的 policyCommands 与启动日志),不参与任何放行判断。
  // **Task 4 埋下「antigravity/recent-paths 可无确认执行」那个洞,成因正是它:**
  // 它把 acknowledgement-required 也算作「allowed」,而当时 /start 读的就是它——
  // 于是「判决说需要确认」在执行面上等价于「放行」。名字比职责大,别再拿它当白名单。
  // (重命名是后续候选,本 task 不动。)
  const allowedCommands = new Set(
    decisions
      .filter((d) => d.state === 'ready' || d.state === 'acknowledgement-required')
      .map((d) => d.commandKey),
  )

  // **deniedCommands 只含显式 deny,不是「所有被拒命令」的全集。** 算法第 7 步能产出
  // denied/tier-threshold,那些命令不进本表;unknown 的更不在。别拿它当全集用——
  // 要判「这条命令能不能跑」只有一个事实源:decisionByKey。
  // Task 6 把 validateStartRequest 改成读判决后,本表**已无运行时消费点**,
  // 只剩下面 description 里的计数;而那句措辞正是「显式 deny K 条」,与本表语义相符。
  const deniedCommands = new Map()
  for (const [commandKey, rule] of Object.entries(COMMAND_POLICY_OVERRIDES)) {
    if (rule?.decision !== 'deny') continue
    deniedCommands.set(commandKey, rule.reason)
  }

  // description 是**用户可见文案**:host-server.mjs 把它当 /health 的 executionPolicy 字段下发,
  // index.mjs 打进启动日志。所以它必须说的是**当前真实的事实源**。
  // 旧文案写着 `access=read, strategy=public, browser=false` —— 那正是 spec §4.3 已废除的三条件
  // (public-direct 不再是需要允许集的 tier,改由 legacy 基线承接)。留着就是对用户说假话。
  const legacyCount = decisions.filter((d) => d.decisionSource === 'legacy-baseline').length
  const tierCount = decisions.filter((d) => (
    d.decisionSource === 'tier-evaluation'
    && (d.state === 'ready' || d.state === 'acknowledgement-required')
  )).length

  return {
    opencliVersion: snapshot.opencliVersion,
    allowedCommands,
    deniedCommands,
    decisions,
    decisionByKey,
    description: `逐命令判决:legacy 基线 ${legacyCount} 条 + tier 审定放行 ${tierCount} 条;`
      + `显式 deny ${deniedCommands.size} 条,其余一律 unknown 拒绝(fail-closed)`,
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
  // 按**判决**分派(spec §6.3 状态码表)。此前这里读的是 allowedCommands.has(),
  // 而 allowedCommands 含 acknowledgement-required —— 于是 antigravity/recent-paths
  // 自 Task 4 起可以**无确认执行**。下面的 428 分支就是补上那个洞。
  const decision = policy.decisionByKey?.get(commandKey)
  if (!decision || decision.state === 'denied' || decision.state === 'unknown') {
    // summary 保持不变(冻结契约:前端 summary 常显 / detail 按需展开)。
    // unknown 与 denied 同归 403——对调用方而言「未审定」同样是拒绝;由 reasonCode 区分。
    const error = new RequestPolicyError(403, 'Command is outside the P0-B execution policy',
      decision?.reason ? `${commandKey}: ${decision.reason}` : commandKey)
    error.reasonCode = decision?.reasonCode ?? 'no-decision'
    throw error
  }
  // 这两支必须早于放行,且**晚于**上面的 denied/unknown ——
  // 否则带一个 fingerprint 就能把 denied 命令送进执行面。acknowledgement 只防误点,
  // 不是安全授权 [I-P5];执行边界是上面那道 403。
  if (decision.state === 'acknowledgement-required') {
    const supplied = value.acknowledgement?.fingerprint
    if (typeof supplied !== 'string') {
      const error = new RequestPolicyError(428, 'Command requires an acknowledgement', commandKey)
      error.reasonCode = 'acknowledgement-required'
      throw error
    }
    if (supplied !== decision.fingerprint) {
      const error = new RequestPolicyError(409, 'Acknowledgement fingerprint is stale',
        '重新拉取 /catalog/effective 后再确认')
      error.reasonCode = 'fingerprint-stale'
      throw error
    }
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
