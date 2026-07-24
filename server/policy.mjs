import { readFileSync } from 'node:fs'

export class RequestPolicyError extends Error {
  constructor(statusCode, message, detail) {
    super(message)
    this.name = 'RequestPolicyError'
    this.statusCode = statusCode
    this.detail = detail
  }
}

export function loadExecutionPolicy(catalogPath) {
  const snapshot = JSON.parse(readFileSync(catalogPath, 'utf8').replace(/^\uFEFF/, ''))
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

  return {
    opencliVersion: snapshot.opencliVersion,
    allowedCommands,
    description: 'catalog: access=read, strategy=public, browser=false',
  }
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
    throw new RequestPolicyError(403, 'Command is outside the P0-B execution policy', commandKey)
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
