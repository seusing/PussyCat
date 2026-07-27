import { readFileSync } from 'node:fs'

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

export function buildExecutionPolicy(snapshot) {
  if (!Array.isArray(snapshot.commands)) {
    throw new Error('Catalog snapshot has no commands array')
  }

  const allowedCommands = new Set(
    snapshot.commands
      .filter((command) => (
        command.access === 'read'
        && command.strategy === 'public'
        && command.browser === false
      ))
      .map((command) => command.command),
  )

  // 派生判决在前,显式 deny 在后 —— 顺序即语义:覆盖表拿得掉派生结果,反之不行。
  const deniedCommands = new Map()
  for (const [commandKey, rule] of Object.entries(COMMAND_POLICY_OVERRIDES)) {
    if (rule?.decision !== 'deny') continue
    deniedCommands.set(commandKey, rule.reason)
    allowedCommands.delete(commandKey)
  }

  return {
    opencliVersion: snapshot.opencliVersion,
    allowedCommands,
    deniedCommands,
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
