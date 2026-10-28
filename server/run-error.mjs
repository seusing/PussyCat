// 命令运行失败的归类:把 OpenCLI 的失败翻成中文 summary(带下一步),原始英文摘要与
// stderr 尾部放进 detail,界面默认只露前者。
//
// 归类依据(@jackwener/opencli 1.8.8,dist/src 下):
//  · errors.js           CliError 的 code / exitCode 表与 toEnvelope() 的字段
//  · commanderAdapter.js renderError():站点命令失败时向 stderr 写 yaml.dump(envelope),
//                        其中 `  code: XXX` 是稳定标识,message/help 才是英文文案
//  · browser/errors.js、browser/daemon-lifecycle.js、daemon-utils.js、browser/daemon-client.js
//                        浏览器桥的错误:BrowserConnectError 带 code,BrowserCommandError 不是
//                        CliError,会落成 `code: UNKNOWN` + 原始 message,只能按文案认
//  · clis/** 各适配器    AuthRequiredError(AUTH_REQUIRED,help 里带 https://<域名>)、
//                        SECURITY_BLOCK(小红书风控)、LoginWallError(LOGIN_WALL)
//
// OpenCLI 2.0 把失败信封改写到 stdout:{"ok":false,"error":{"code","message","exitCode","hint"}}
// (错误码沿用 1.8.8),警告和日志留在 stderr。归类先看 stdout 信封,再看 stderr 的 1.8.8 YAML
// 信封,最后看退出码。

const STDERR_TAIL_CHARS = 8000

const BROWSER_NOT_CONNECTED = '浏览器没连上：点左下角的修复按钮，或打开装有 OpenCLI 扩展的 Chrome 后重试'
const TIMED_OUT = '执行超时：网络较慢或页面卡住，稍后重试'
const NEEDS_VERIFICATION = '网站要求验证：在 Chrome 里打开该网站完成验证后重试'
const GENERIC_FAILURE = '命令执行失败'

function needsLogin(domain) {
  return `需要先登录${domain ? ` ${domain}` : '该网站'}：在 Chrome 里登录后重试`
}

const KIND_BY_CODE = {
  BROWSER_CONNECT: 'browser',
  AUTH_REQUIRED: 'login',
  TIMEOUT: 'timeout',
  LOGIN_WALL: 'verify',
  SECURITY_BLOCK: 'verify',
}

// 没有可用 code 时才看文案。UNKNOWN 信封里装的是浏览器桥抛出的原始 Error。
const KIND_BY_TEXT = [
  ['browser', /Extension (?:not connected|disconnected)|Browser Bridge extension|opencli daemon|Browser profile ".*" is not connected/i],
  ['timeout', /timed out/i],
]

// 站点命令的退出码(errors.js EXIT_CODES),stderr 读不出信封时的最后依据。
const KIND_BY_EXIT_CODE = { 69: 'browser', 75: 'timeout', 77: 'login' }

/**
 * 已解析的 JSON 若是 2.0 失败信封({ok:false,error:{…}}),返回其 error 字段,否则 undefined。
 * 成功外壳、1.8.8 的行数据(error 是字符串)都不算。
 * @returns {{ code?: string, message?: string, hint?: string } | undefined}
 */
export function failureOf(parsed) {
  const error = parsed && typeof parsed === 'object' && parsed.ok === false ? parsed.error : undefined
  if (!error || typeof error !== 'object') return undefined
  const text = (value) => (typeof value === 'string' ? value : undefined)
  return { code: text(error.code), message: text(error.message), hint: text(error.hint) }
}

/** stdout 原文里的 2.0 失败信封;不是 JSON 或不是这种形状就是 undefined。 */
export function readStdoutError(stdout) {
  const text = String(stdout ?? '').replace(/^\uFEFF/, '').trim()
  if (!text.startsWith('{')) return undefined
  try {
    return failureOf(JSON.parse(text))
  } catch {
    return undefined
  }
}

function envelopeCode(stderr) {
  return /^ {2}code: *['"]?([A-Z][A-Z0-9_]*)['"]?\s*$/m.exec(stderr)?.[1]
}

// AuthRequiredError 的 help(2.0 里叫 hint)恒为 `Please open Chrome or Chromium and log in to https://<域名>`。
function loginDomain(...texts) {
  for (const text of texts) {
    const domain = /log in to https?:\/\/([A-Za-z0-9.-]+)/i.exec(text ?? '')?.[1]
    if (domain) return domain
  }
  return undefined
}

function classify({ stdoutError, stderr, exitCode, timedOut }) {
  if (timedOut) return 'timeout'
  for (const code of [stdoutError?.code, envelopeCode(stderr)]) {
    if (code && KIND_BY_CODE[code]) return KIND_BY_CODE[code]
  }
  const text = [stdoutError?.message, stdoutError?.hint, stderr].filter(Boolean).join('\n')
  for (const [kind, pattern] of KIND_BY_TEXT) {
    if (pattern.test(text)) return kind
  }
  return KIND_BY_EXIT_CODE[exitCode]
}

/**
 * @param {object} input
 * @param {string} input.summary 原始英文摘要,进 detail
 * @param {string} [input.detail] 附加细节(异常信息、stderr 尾部),进 detail
 * @param {string} [input.stderr] 完整 stderr,用来归类
 * @param {string} [input.stdout] 完整 stdout,2.0 的失败信封在这里
 * @param {number} [input.exitCode]
 * @param {boolean} [input.timedOut] 宿主自己的超时终止
 * @returns {{ summary: string, detail: string }}
 */
export function describeRunError({ summary, detail, stderr = '', stdout = '', exitCode, timedOut = false }) {
  const tail = stderr.slice(-STDERR_TAIL_CHARS)
  const stdoutError = readStdoutError(stdout)
  const kind = classify({ stdoutError, stderr: tail, exitCode, timedOut })
  const text = {
    browser: BROWSER_NOT_CONNECTED,
    login: needsLogin(loginDomain(stdoutError?.hint, stdoutError?.message, tail)),
    timeout: TIMED_OUT,
    verify: NEEDS_VERIFICATION,
  }[kind] ?? GENERIC_FAILURE
  const original = stdoutError
    ? [[stdoutError.code, stdoutError.message].filter(Boolean).join(': '), stdoutError.hint].filter(Boolean).join('\n')
    : undefined
  return { summary: text, detail: [summary, original, detail].filter(Boolean).join('\n') }
}
