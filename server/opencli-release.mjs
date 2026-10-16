// 查 npm 上 OpenCLI 的最新版本。只检查、不升级:执行许可的哈希含 opencli 版本,
// 换版本会让全部命令失效,新版 OpenCLI 随新版爪爪一起提供。

// npmjs 在国内直连时快时慢,npmmirror 是它的国内镜像;两个并发请求,取先成功的那个。
const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
const PACKAGE_PATH = '@jackwener/opencli/latest'
const RELEASE_URL_PREFIX = 'https://github.com/jackwener/opencli/releases/tag/v'
const SEMVER = /^\d+\.\d+\.\d+$/

function isNewer(latest, current) {
  if (!SEMVER.test(latest) || !SEMVER.test(current)) return false
  const a = latest.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

// undici 把真正的原因放在 error.cause.code(ECONNREFUSED 等);超时来自 AbortSignal.timeout。
function describeNetworkError(error, timeoutMs) {
  if (!(error instanceof Error)) return String(error)
  if (error.name === 'TimeoutError') return `请求超时（${timeoutMs / 1000} 秒）`
  const code = error.cause?.code
  return typeof code === 'string' ? `${error.message}（${code}）` : error.message
}

async function fetchLatestVersion(registry, fetchImpl, timeoutMs) {
  const { host } = new URL(registry)
  let response
  try {
    response = await fetchImpl(`${registry}/${PACKAGE_PATH}`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new Error(`连不上 ${host}：${describeNetworkError(error, timeoutMs)}`)
  }
  if (!response.ok) throw new Error(`${host} 返回 HTTP ${response.status}`)
  let body
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (typeof body?.version !== 'string') throw new Error(`${host} 的响应里没有版本号`)
  return body.version
}

export async function checkOpencliRelease({
  currentVersion,
  fetchImpl = (url, init) => fetch(url, init),
  now = Date.now,
  timeoutMs = 8000,
} = {}) {
  let latest
  try {
    latest = await Promise.any(REGISTRIES.map((registry) => fetchLatestVersion(registry, fetchImpl, timeoutMs)))
  } catch (error) {
    throw new Error(error.errors.map((reason) => reason.message).join('；'))
  }
  return {
    checkedAt: now(),
    current: currentVersion,
    latest,
    updateAvailable: isNewer(latest, currentVersion),
    releaseUrl: `${RELEASE_URL_PREFIX}${latest}`,
  }
}
