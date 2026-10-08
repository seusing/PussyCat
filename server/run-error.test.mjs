// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { describeRunError } from './run-error.mjs'

// 样本取自 @jackwener/opencli 1.8.6 的 toEnvelope() + yaml.dump(…, { lineWidth: 120 }) 实际输出
// (commanderAdapter.js renderError 写进 stderr 的内容),exitCode 为对应 CliError 的退出码。
const STDERR = {
  authRequired: `ok: false
error:
  code: AUTH_REQUIRED
  message: Not logged in to www.xiaohongshu.com
  help: Please open Chrome or Chromium and log in to https://www.xiaohongshu.com
  exitCode: 77
`,
  authRequiredX: `ok: false
error:
  code: AUTH_REQUIRED
  message: Not logged into x.com (no ct0 cookie)
  help: Please open Chrome or Chromium and log in to https://x.com
  exitCode: 77
`,
  timeout: `ok: false
error:
  code: TIMEOUT
  message: xiaohongshu note timed out after 90s
  help: Try again, or increase timeout with --timeout <seconds> (or OPENCLI_BROWSER_COMMAND_TIMEOUT for the global default)
  exitCode: 75
`,
  loginWall: `ok: false
error:
  code: LOGIN_WALL
  message: Bilibili API returned HTML instead of JSON
  help: >-
    The server returned an HTML page instead of JSON — likely a login wall, rate limit, or WAF challenge. Try re-logging
    in via your browser, or wait a few minutes before retrying.
  exitCode: 77
`,
  securityBlock: `ok: false
error:
  code: SECURITY_BLOCK
  message: 'Xiaohongshu security block: the note detail page was blocked by risk control.'
  help: Open the note in Chrome, finish verification, retry
  exitCode: 1
`,
  extensionNotConnected: `ok: false
error:
  code: BROWSER_CONNECT
  message: Browser Bridge extension is not connected.
  help: Install the extension from GitHub Releases, then reload.
  exitCode: 69
`,
  daemonDown: `ok: false
error:
  code: BROWSER_CONNECT
  message: |-
    Cannot connect to opencli daemon.

    ECONNREFUSED 127.0.0.1:19825
  help: Run \`opencli doctor\` to diagnose, or \`opencli daemon restart\` to force a fresh daemon. Default port is 19825.
  exitCode: 69
`,
  // BrowserCommandError 不是 CliError,toEnvelope 把它落成 UNKNOWN + 原始 message。
  unknownExtension: `ok: false
error:
  code: UNKNOWN
  message: Extension not connected. Please install the opencli Browser Bridge extension.
  exitCode: 1
`,
  unknownCommandTimeout: `ok: false
error:
  code: UNKNOWN
  message: Browser click command timed out after 30s; it may still complete in the browser.
  exitCode: 1
`,
  commandExec: `ok: false
error:
  code: COMMAND_EXEC
  message: xiaohongshu collection API returned a malformed payload
  exitCode: 1
`,
  emptyResult: `ok: false
error:
  code: EMPTY_RESULT
  message: xiaohongshu/search returned no data
  help: The page structure may have changed, or you may need to log in
  exitCode: 66
`,
}

const BROWSER = '浏览器没连上：点左下角的修复按钮，或打开装有 OpenCLI 扩展的 Chrome 后重试'
const TIMEOUT = '执行超时：网络较慢或页面卡住，稍后重试'
const VERIFY = '网站要求验证：在 Chrome 里打开该网站完成验证后重试'
const GENERIC = '命令执行失败'

function describeExit(stderr, exitCode, extra = {}) {
  return describeRunError({
    summary: `OpenCLI exited with code ${exitCode}`,
    detail: stderr.trim(),
    stderr,
    exitCode,
    ...extra,
  })
}

describe('describeRunError', () => {
  it.each([
    ['扩展未连接', STDERR.extensionNotConnected, 69, BROWSER],
    ['浏览器服务没起来', STDERR.daemonDown, 69, BROWSER],
    ['扩展断开(UNKNOWN 信封,按文案认)', STDERR.unknownExtension, 1, BROWSER],
    ['OpenCLI 自己的超时', STDERR.timeout, 75, TIMEOUT],
    ['浏览器命令超时(UNKNOWN 信封,按文案认)', STDERR.unknownCommandTimeout, 1, TIMEOUT],
    ['登录墙/风控页(HTML 代替 JSON)', STDERR.loginWall, 77, VERIFY],
    ['小红书安全拦截', STDERR.securityBlock, 1, VERIFY],
    ['适配器自己的执行错误', STDERR.commandExec, 1, GENERIC],
    ['没有数据', STDERR.emptyResult, 66, GENERIC],
  ])('%s', (_name, stderr, exitCode, expected) => {
    expect(describeExit(stderr, exitCode).summary).toBe(expected)
  })

  it('登录失效时带上 OpenCLI 给出的站点域名', () => {
    expect(describeExit(STDERR.authRequired, 77).summary)
      .toBe('需要先登录 www.xiaohongshu.com：在 Chrome 里登录后重试')
    expect(describeExit(STDERR.authRequiredX, 77).summary)
      .toBe('需要先登录 x.com：在 Chrome 里登录后重试')
  })

  it('拿不到域名时说「该网站」', () => {
    const stderr = 'ok: false\nerror:\n  code: AUTH_REQUIRED\n  message: login needed\n  exitCode: 77\n'
    expect(describeExit(stderr, 77).summary).toBe('需要先登录该网站：在 Chrome 里登录后重试')
  })

  it('宿主自己的超时终止优先于 stderr 里的内容', () => {
    const result = describeRunError({
      summary: 'OpenCLI timed out after 90000ms',
      stderr: STDERR.authRequired,
      timedOut: true,
    })
    expect(result.summary).toBe(TIMEOUT)
  })

  it('读不出信封时按退出码兜底', () => {
    expect(describeExit('', 69).summary).toBe(BROWSER)
    expect(describeExit('garbled', 75).summary).toBe(TIMEOUT)
    expect(describeExit('garbled', 77).summary).toBe('需要先登录该网站：在 Chrome 里登录后重试')
  })

  it('其余一律「命令执行失败」', () => {
    expect(describeExit('network failed', 2).summary).toBe(GENERIC)
    expect(describeExit('', 1).summary).toBe(GENERIC)
    expect(describeRunError({ summary: 'OpenCLI returned invalid JSON', detail: 'Unexpected token' }).summary).toBe(GENERIC)
  })

  it('原始英文摘要和 stderr 尾部进 detail,不丢', () => {
    const result = describeRunError({
      summary: 'OpenCLI exited with code 77',
      detail: STDERR.authRequired.trim(),
      stderr: STDERR.authRequired,
      exitCode: 77,
    })
    expect(result.detail.split('\n')[0]).toBe('OpenCLI exited with code 77')
    expect(result.detail).toContain('message: Not logged in to www.xiaohongshu.com')
  })

  it('没有附加细节时 detail 只有原始摘要', () => {
    expect(describeRunError({ summary: 'OpenCLI process error' }).detail).toBe('OpenCLI process error')
  })

  it('信封里嵌套更深的 code: 行不会被当成错误码', () => {
    const stderr = 'ok: false\nerror:\n  code: COMMAND_EXEC\n  message: x\n  cause: |-\n    inner\n    code: AUTH_REQUIRED\n  exitCode: 1\n'
    expect(describeExit(stderr, 1).summary).toBe(GENERIC)
  })
})
