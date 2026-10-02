import { DEFAULT_BASE_URL } from '../../host/nodeBridgeHost'
import { addInspirationItem, findInspirationItemBySource, type InspirationItem } from './inspirationLibrary'
import { wechatArticleToMarkdown, type WechatArticle } from './wechatArticleMarkdown'

export interface WechatArticleResult {
  item: InspirationItem
  created: boolean
}

const ARTICLE_URL = /https?:\/\/mp\.weixin\.qq\.com\/s[^\s"'<>，。）)]*/i
const ARTICLE_KEYS = ['__biz', 'mid', 'idx', 'sn']

// 宿主 reasonCode 对应的提示;其余状态码走通用提示。
const FAILURE_MESSAGES: Record<string, string> = {
  'invalid-url': '不是公众号文章链接',
  'verification-required': '微信要求验证，暂时抓不到，请稍后再试',
  unavailable: '文章已删除或不可访问',
  network: '网络错误',
}

// 同一篇文章会以短链、带追踪参数的长链等不同形式出现,去掉无关参数后才能按链接去重。
export function wechatArticleUrl(text: string) {
  const match = text.match(ARTICLE_URL)
  if (!match) return ''
  try {
    const url = new URL(match[0])
    if (url.hostname !== 'mp.weixin.qq.com') return ''
    if (url.pathname.startsWith('/s/') && url.pathname.length > 3) return `https://mp.weixin.qq.com${url.pathname}`
    if (url.pathname !== '/s') return ''
    const query = new URLSearchParams()
    for (const key of ARTICLE_KEYS) {
      const value = url.searchParams.get(key)
      if (value) query.set(key, value)
    }
    return ARTICLE_KEYS.every((key) => query.has(key)) ? `https://mp.weixin.qq.com/s?${query}` : ''
  } catch {
    return ''
  }
}

const collapse = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()

// 页面内联脚本里的变量,如 var nickname = htmlDecode("名称"); / var msg_title = '标题'.html(false);
function scriptString(html: string, name: string) {
  const match = html.match(new RegExp(`\\bvar\\s+${name}\\s*=\\s*(?:htmlDecode\\()?(["'])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`))
  if (!match) return ''
  const unescaped = match[2].replace(
    /\\x([0-9a-f]{2})|\\u([0-9a-f]{4})|\\(.)/gi,
    (_all, hex?: string, unicode?: string, char?: string) => (hex || unicode ? String.fromCharCode(parseInt(hex || unicode!, 16)) : char!),
  )
  return collapse(new DOMParser().parseFromString(unescaped, 'text/html').documentElement.textContent)
}

// #publish_time 是页面脚本事后填的,静态 HTML 里只有 var ct(秒级时间戳)。
function publishTime(html: string) {
  const seconds = Number(scriptString(html, 'ct') || scriptString(html, 'createTimestamp'))
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false })
  return scriptString(html, 'createTime')
}

export function parseWechatArticle(html: string, link: string): WechatArticle {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const content = doc.getElementById('js_content')
  if (!content) throw new Error(FAILURE_MESSAGES.unavailable)
  return {
    title: collapse(doc.querySelector('meta[property="og:title"]')?.getAttribute('content'))
      || collapse(doc.getElementById('activity-name')?.textContent)
      || scriptString(html, 'msg_title')
      || '未命名文章',
    author: collapse(doc.getElementById('js_name')?.textContent) || scriptString(html, 'nickname'),
    publishTime: publishTime(html),
    link,
    contentHtml: content.innerHTML,
  }
}

async function fetchArticleHtml(base: string | undefined, url: string, signal?: AbortSignal) {
  let response: Response
  try {
    response = await fetch(
      `${(base || DEFAULT_BASE_URL).replace(/\/$/, '')}/inspiration/wechat-article?url=${encodeURIComponent(url)}`,
      { cache: 'no-store', signal },
    )
  } catch (error) {
    if (error instanceof TypeError) throw new Error('无法连接爪爪本地服务，请稍后重试')
    throw error
  }
  const body = (await response.json().catch(() => null)) as { html?: unknown; reasonCode?: unknown } | null
  if (!response.ok) {
    const reason = typeof body?.reasonCode === 'string' ? body.reasonCode : ''
    throw new Error(FAILURE_MESSAGES[reason] ?? `添加公众号文章失败（${response.status}）`)
  }
  return String(body?.html ?? '')
}

export async function collectWechatArticle(
  base: string | undefined,
  text: string,
  signal?: AbortSignal,
  folderId: string | null = null,
): Promise<WechatArticleResult> {
  const url = wechatArticleUrl(text)
  if (!url) throw new Error(FAILURE_MESSAGES['invalid-url'])
  const existing = findInspirationItemBySource(url)
  if (existing) return { item: existing, created: false }
  const article = parseWechatArticle(await fetchArticleHtml(base, url, signal), url)
  const item = addInspirationItem({
    title: article.title,
    content: wechatArticleToMarkdown(article),
    kind: 'article',
    format: 'md',
    folderId,
    source: url,
  })
  if (!item) throw new Error('保存到灵感库失败，请检查本地存储空间')
  return { item, created: true }
}
