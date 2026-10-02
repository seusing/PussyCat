import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WECHAT_ARTICLE_CT, WECHAT_ARTICLE_PAGE } from '../../testing/wechatArticleFixture'
import { addInspirationFolder, loadInspirationLibrary } from './inspirationLibrary'
import { collectWechatArticle, parseWechatArticle, wechatArticleUrl } from './wechatArticle'

const ARTICLE = 'https://mp.weixin.qq.com/s/abc'
const expectedTime = new Date(WECHAT_ARTICLE_CT * 1000).toLocaleString('zh-CN', { hour12: false })

function reply(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

function stubHost(response: () => Promise<Response> = () => reply({ finalUrl: ARTICLE, html: WECHAT_ARTICLE_PAGE })) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => response())
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('wechatArticleUrl', () => {
  it('normalizes short and long article links', () => {
    expect(wechatArticleUrl('https://mp.weixin.qq.com/s/abc-_1?scene=1#rd')).toBe('https://mp.weixin.qq.com/s/abc-_1')
    expect(
      wechatArticleUrl('https://mp.weixin.qq.com/s?__biz=MzA3==&mid=1&idx=2&sn=f00&chksm=aa&scene=21#wechat_redirect'),
    ).toBe('https://mp.weixin.qq.com/s?__biz=MzA3%3D%3D&mid=1&idx=2&sn=f00')
  })

  it('extracts the link from shared text and rejects other pages', () => {
    expect(wechatArticleUrl('推荐一篇：https://mp.weixin.qq.com/s/abc 值得看')).toBe(ARTICLE)
    expect(wechatArticleUrl('https://mp.weixin.qq.com/s?src=11&timestamp=1')).toBe('')
    expect(wechatArticleUrl('https://example.com/s/abc')).toBe('')
  })
})

describe('parseWechatArticle', () => {
  it('reads title, account, publish time and body from the article page', () => {
    const article = parseWechatArticle(WECHAT_ARTICLE_PAGE, ARTICLE)
    expect(article).toMatchObject({
      title: '苹果子公司因违反对俄制裁受到英国处罚',
      author: '合规小叨客',
      publishTime: expectedTime,
      link: ARTICLE,
    })
    expect(article.contentHtml).toContain('正文内容')
    expect(article.contentHtml).toContain('data-src="https://mmbiz.qpic.cn/mmbiz_jpg/x/640?wx_fmt=jpeg"')
  })

  it('falls back to the page title element and inline script variables', () => {
    const page = WECHAT_ARTICLE_PAGE
      .replace(/<meta property="og:title"[^>]*>/, '')
      .replace(/<a [^>]*id="js_name">[\s\S]*?<\/a>/, '')
    expect(parseWechatArticle(page, ARTICLE)).toMatchObject({ title: '苹果子公司因违反对俄制裁受到英国处罚', author: '合规小叨客' })

    const scriptOnly = '<div id="js_content"><p>x</p></div><script>var msg_title = \'A \\x26amp; B\'.html(false);var nickname = htmlDecode("名\\u79f0");var createTime = \'2026-03-31 09:56\';</script>'
    expect(parseWechatArticle(scriptOnly, ARTICLE)).toMatchObject({ title: 'A & B', author: '名称', publishTime: '2026-03-31 09:56' })
  })

  it('rejects pages without the article body', () => {
    expect(() => parseWechatArticle('<html><body>该内容已被发布者删除</body></html>', ARTICLE)).toThrow('文章已删除或不可访问')
  })
})

describe('collectWechatArticle', () => {
  it('fetches the article through the host and saves it as Markdown', async () => {
    const fetchMock = stubHost()
    const result = await collectWechatArticle('http://127.0.0.1:5000', 'https://mp.weixin.qq.com/s/abc?scene=1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `http://127.0.0.1:5000/inspiration/wechat-article?url=${encodeURIComponent(ARTICLE)}`,
    )
    expect(result.created).toBe(true)
    expect(result.item).toMatchObject({
      title: '苹果子公司因违反对俄制裁受到英国处罚',
      kind: 'article',
      format: 'md',
      source: ARTICLE,
    })
    expect(result.item.content).toContain(`> 公众号：合规小叨客 · 发布时间：${expectedTime} · [原文链接](${ARTICLE})`)
    expect(result.item.content).toContain('正文内容')
    expect(result.item.content).toContain('![配图](https://mmbiz.qpic.cn/mmbiz_jpg/x/640?wx_fmt=jpeg)')
    expect(loadInspirationLibrary().items).toHaveLength(1)
  })

  it('accepts the long link form', async () => {
    const fetchMock = stubHost()
    const { item } = await collectWechatArticle(undefined, 'https://mp.weixin.qq.com/s?__biz=MzA3&mid=1&idx=2&sn=f00&scene=21')
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/inspiration/wechat-article?url=${encodeURIComponent('https://mp.weixin.qq.com/s?__biz=MzA3&mid=1&idx=2&sn=f00')}`,
    )
    expect(item.source).toBe('https://mp.weixin.qq.com/s?__biz=MzA3&mid=1&idx=2&sn=f00')
  })

  it('saves into the folder the user is browsing', async () => {
    stubHost()
    const folder = addInspirationFolder('资料')!
    const { item } = await collectWechatArticle(undefined, ARTICLE, undefined, folder.id)
    expect(item.folderId).toBe(folder.id)
  })

  it('returns the existing item without refetching a saved article', async () => {
    const fetchMock = stubHost()
    const first = await collectWechatArticle(undefined, ARTICLE)
    fetchMock.mockClear()

    const second = await collectWechatArticle(undefined, `${ARTICLE}#rd`)
    expect(second).toEqual({ item: first.item, created: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid-url', 400, '不是公众号文章链接'],
    ['verification-required', 429, '微信要求验证，暂时抓不到，请稍后再试'],
    ['unavailable', 404, '文章已删除或不可访问'],
    ['network', 502, '网络错误'],
  ])('explains the host failure %s', async (reasonCode, status, message) => {
    stubHost(() => reply({ error: 'x', reasonCode }, status))
    await expect(collectWechatArticle(undefined, ARTICLE)).rejects.toThrow(message)
    expect(loadInspirationLibrary().items).toHaveLength(0)
  })

  it('reports an unreachable host and unexpected responses', async () => {
    stubHost(() => Promise.reject(new TypeError('Failed to fetch')))
    await expect(collectWechatArticle(undefined, ARTICLE)).rejects.toThrow('无法连接爪爪本地服务，请稍后重试')

    stubHost(() => reply({ error: 'boom' }, 500))
    await expect(collectWechatArticle(undefined, ARTICLE)).rejects.toThrow('添加公众号文章失败（500）')
  })

  it('rejects text without a WeChat article link', async () => {
    const fetchMock = stubHost()
    await expect(collectWechatArticle(undefined, '随便一段文字')).rejects.toThrow('不是公众号文章链接')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
