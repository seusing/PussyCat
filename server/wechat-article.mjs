// 公众号单篇文章的抓取。宿主直接取公开文章页,渲染进程不直连微信:应用 CSP 只放行
// 'self' 与 127.0.0.1,而且微信对不带浏览器 UA 的请求会重定向到验证页。
import { fetch as undiciFetch, ProxyAgent } from 'undici'

const ARTICLE_HOST = 'mp.weixin.qq.com'
const IMAGE_HOSTS = ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'mmecoa.qpic.cn']
const ARTICLE_KEYS = ['__biz', 'mid', 'idx', 'sn']
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REQUEST_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 20_000
const MAX_BYTES = 10 * 1024 * 1024
const CAPTCHA_PATH = 'wappoc_appmsgcaptcha'

// reasonCode 是 wire 上的稳定标识,前端只认它。
export class WechatArticleError extends Error {
  constructor(statusCode, reasonCode, message) {
    super(message)
    this.name = 'WechatArticleError'
    this.statusCode = statusCode
    this.reasonCode = reasonCode
  }
}

const invalidUrl = () => new WechatArticleError(400, 'invalid-url', '不是公众号文章链接')
const verificationRequired = () => new WechatArticleError(429, 'verification-required', '微信要求验证，暂时抓不到文章')
const unavailable = () => new WechatArticleError(404, 'unavailable', '文章已删除或不可访问')
const network = () => new WechatArticleError(502, 'network', '网络错误')

let proxyAgent
let proxyUrl

function resetProxyAgent() {
  const agent = proxyAgent
  proxyAgent = undefined
  proxyUrl = undefined
  try {
    agent?.destroy?.()?.catch?.(() => {})
  } catch {
    // 清理失败不能连累下一次请求。
  }
}

function defaultFetch(url, init = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
  if (!proxy) return undiciFetch(url, init)
  if (!proxyAgent || proxyUrl !== proxy) {
    resetProxyAgent()
    proxyAgent = new ProxyAgent(proxy)
    proxyUrl = proxy
  }
  const dispatcher = proxyAgent
  return undiciFetch(url, { ...init, dispatcher }).catch((error) => {
    if (proxyAgent === dispatcher) resetProxyAgent()
    throw error
  })
}

// 只认 https://mp.weixin.qq.com/s/<id> 与带 __biz/mid/idx/sn 的长链接。
function articleUrl(value) {
  let url
  try { url = new URL(String(value)) } catch { return null }
  if (url.protocol !== 'https:' || url.hostname !== ARTICLE_HOST || url.port || url.username || url.password) return null
  if (url.pathname.startsWith('/s/') && url.pathname.length > 3) return url
  if (url.pathname === '/s' && ARTICLE_KEYS.every((key) => url.searchParams.get(key))) return url
  return null
}

async function readBody(response) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw unavailable()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_BYTES) throw unavailable()
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function fetchWechatArticle(value, { fetchImpl = defaultFetch } = {}) {
  let current = articleUrl(value)
  if (!current) throw invalidUrl()
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  try {
    for (let redirects = 0; ; redirects += 1) {
      if (current.href.includes(CAPTCHA_PATH)) throw verificationRequired()
      const response = await fetchImpl(current.href, { headers: REQUEST_HEADERS, redirect: 'manual', signal })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        response.body?.cancel?.().catch(() => {})
        if (!location || redirects >= MAX_REDIRECTS) throw unavailable()
        const next = new URL(location, current)
        if (next.protocol !== 'https:' || next.hostname !== ARTICLE_HOST) throw unavailable()
        current = next
        continue
      }
      if (response.status === 404 || response.status === 410) throw unavailable()
      if (!response.ok) throw network()
      const html = await readBody(response)
      if (!html.includes('id="js_content"')) {
        throw /环境异常|去验证/.test(html) ? verificationRequired() : unavailable()
      }
      return { finalUrl: current.href, html }
    }
  } catch (error) {
    throw error instanceof WechatArticleError ? error : network()
  }
}

// 文章里的图片只放行微信自己的图床,否则这个端点就成了任意地址的代理。
export async function requestArticleImage(value, { fetchImpl = defaultFetch } = {}) {
  let remote
  try { remote = new URL(value) } catch { throw new WechatArticleError(400, 'article-image-url-invalid', '文章图片地址无效') }
  if (!['http:', 'https:'].includes(remote.protocol) || !IMAGE_HOSTS.includes(remote.hostname)) {
    throw new WechatArticleError(400, 'article-image-url-invalid', '文章图片地址无效')
  }
  return fetchImpl(remote.href, { redirect: 'manual' })
}
