// BrowserBridge 健康诊断 —— **复用 opencli 自己的结构化接口,不另起一套 daemon。**
//
// 数据源是 opencli daemon 的 `GET /status`(dist/src/daemon.js:207-237),一个真正的 JSON 端点。
// 不去解析 `opencli doctor` 的人读 stdout:那是给人看的排版,措辞随版本漂移,拿它当协议迟早断。
// (`@jackwener/opencli` 的 package.json exports 没有映射 `./doctor` 与 `./browser/daemon-client`,
//  所以也没法直接 import 它们的编程接口 —— HTTP 是本仓唯一能稳定拿到的结构化面。)
//
// **必须由 Host 代理,前端不得直连**:daemon 拒绝非 `chrome-extension://` 的 Origin
// (daemon.js:353-360)并要求 `X-OpenCLI` 头(:203-206)。WebView 本来就打不通,
// 这两道防线不该因为「前端要看状态」而被绕开或放宽。

// daemon 端口是**写死的**:constants.js:5 定义 19825,且 :19-25 明写 OPENCLI_DAEMON_PORT
// 取非默认值时 opencli 直接报错——扩展只连这一个端口。参数化只为测试注入。
export const DAEMON_ORIGIN = 'http://127.0.0.1:19825'

const DEFAULT_TIMEOUT_MS = 2000

/**
 * 把 daemon 的 /status 投影成前端可见的健康结构。
 *
 * **投影,不透传。** 逐字段挑选,绝不 `...status` 展开——否则 opencli 升级新增字段会自动流到
 * 前端,白名单当场失效(与 legacy artifact「禁止自动重建」是同一类失效模式)。
 *
 * 被**有意剔除**的字段及理由(审定文档 §7):
 *   · `pid` / `port` —— 本机进程标识与回环端点,前端零用途,却给页面上下文一个可定位的目标;
 *   · `memoryMB` —— 遥测噪音,无 UI 价值;
 *   · `contextId` —— **这是 Chrome profile 标识符**,也是 trace 目录的路径段
 *     (observation/artifact.js:16),稳定且可关联到具体浏览器 profile;
 *   · `profiles[]` —— 每项都含 contextId 与 lastSeenAt(浏览器活动时间戳,一种行为信号),
 *     只转发**条数**。
 * daemon 的 /status 本身不含 cookie / token / 账号数据(已核 daemon.js:207-237),
 * 但本函数的白名单是**正向枚举**,即便上游将来加了这类字段也流不出去。
 */
function projectStatus(status, { opencliVersion, checkedAt }) {
  const extensionConnected = status.extensionConnected === true
  const profileRequired = status.profileRequired === true
  const profileDisconnected = status.profileDisconnected === true

  let profile = 'ready'
  if (profileRequired) profile = 'required'
  else if (profileDisconnected) profile = 'disconnected'
  else if (!extensionConnected) profile = 'unknown'

  let reasonCode = 'ok'
  let summary = '浏览器桥接就绪'
  if (profileRequired) {
    reasonCode = 'profile-required'
    summary = '有多个浏览器 profile 连着,需要先指定用哪一个'
  } else if (profileDisconnected) {
    reasonCode = 'profile-disconnected'
    summary = '指定的浏览器 profile 当前未连接'
  } else if (!extensionConnected) {
    reasonCode = 'extension-disconnected'
    summary = 'daemon 在运行,但 Chrome 扩展未连上'
  }

  return {
    checkedAt,
    daemon: 'running',
    daemonVersion: typeof status.daemonVersion === 'string' ? status.daemonVersion : undefined,
    extension: extensionConnected ? 'connected' : 'disconnected',
    extensionVersion: typeof status.extensionVersion === 'string' ? status.extensionVersion : undefined,
    extensionCompatRange: typeof status.extensionCompatRange === 'string' ? status.extensionCompatRange : undefined,
    profile,
    // 只转条数,不转 profiles[] 本身(每项都含 contextId 与 lastSeenAt)。
    profileCount: Array.isArray(status.profiles) ? status.profiles.length : 0,
    pending: Number.isFinite(status.pending) ? status.pending : undefined,
    commandResultUnknown: Number.isFinite(status.commandResultUnknown) ? status.commandResultUnknown : undefined,
    opencliVersion,
    // 「还没就绪」与「重试有用吗」是两件事:扩展没连上时重试是有意义的(用户去点一下扩展就好),
    // 所以除了 ok 之外一律 retryable —— 这里没有任何一种失败是「重试必然徒劳」的。
    retryable: reasonCode !== 'ok',
    reasonCode,
    summary,
  }
}

function unreachable({ reasonCode, summary, opencliVersion, checkedAt, daemon = 'stopped' }) {
  return {
    checkedAt,
    daemon,
    extension: 'unknown',
    profile: 'unknown',
    profileCount: 0,
    opencliVersion,
    retryable: true,
    reasonCode,
    summary,
  }
}

/**
 * 探测 BrowserBridge 健康状态。**永不抛**:诊断本身失败也是一种诊断结果,
 * 让它抛会把「桥接没就绪」变成「Host 内部错误」,两者给用户的下一步动作完全不同。
 */
export async function checkBrowserBridgeHealth({
  fetchImpl = fetch,
  opencliVersion,
  daemonOrigin = DAEMON_ORIGIN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const checkedAt = now()
  let response
  try {
    response = await fetchImpl(`${daemonOrigin}/status`, {
      headers: { 'X-OpenCLI': '1' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    // 超时与「连不上」要分开:前者是 daemon 在但没响应(卡死/过载),后者多半是根本没起来。
    // 两种情形给用户的下一步不同,合并成一句「桥接失败」等于把排障信息丢掉。
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return unreachable({
      opencliVersion,
      checkedAt,
      daemon: timedOut ? 'unreachable' : 'stopped',
      reasonCode: timedOut ? 'daemon-unreachable' : 'daemon-stopped',
      summary: timedOut
        ? `daemon 未在 ${timeoutMs}ms 内响应`
        : 'daemon 未运行(首次执行浏览器命令时 opencli 会自行拉起)',
    })
  }

  if (!response.ok) {
    return unreachable({
      opencliVersion,
      checkedAt,
      daemon: 'error',
      reasonCode: 'daemon-error',
      summary: `daemon 返回 HTTP ${response.status}`,
    })
  }

  let status
  try {
    status = await response.json()
  } catch {
    return unreachable({
      opencliVersion,
      checkedAt,
      daemon: 'error',
      reasonCode: 'daemon-error',
      summary: 'daemon 响应不是合法 JSON',
    })
  }

  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return unreachable({
      opencliVersion,
      checkedAt,
      daemon: 'error',
      reasonCode: 'daemon-error',
      summary: 'daemon 响应形状异常',
    })
  }

  return projectStatus(status, { opencliVersion, checkedAt })
}
