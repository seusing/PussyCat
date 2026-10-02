import DOMPurify from 'dompurify'
import TurndownService from 'turndown'
import { wechatImageRemote } from './wechatImage'

export interface WechatArticle {
  title: string
  /** 公众号名称,取不到时为空。 */
  author: string
  publishTime: string
  link: string
  contentHtml: string
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
})
turndown.addRule('wechatImage', {
  filter: 'img',
  replacement: (_content, node) => {
    const image = node as HTMLImageElement
    const remote = wechatImageRemote(image.getAttribute('src'), image.getAttribute('data-src'))
    if (!remote) return ''
    const alt = (image.getAttribute('alt') || '').replace(/[[\]]/g, '')
    return `![${alt}](${remote})`
  },
})

export function wechatArticleBodyToMarkdown(html: string) {
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['iframe', 'style'],
  })
  return turndown
    .turndown(sanitized)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function wechatArticleToMarkdown(article: WechatArticle) {
  const meta = [
    article.author ? `公众号：${article.author}` : '',
    article.publishTime ? `发布时间：${article.publishTime}` : '',
    article.link ? `[原文链接](${article.link})` : '',
  ].filter(Boolean)
  return `${[
    `# ${article.title.replace(/\s+/g, ' ').trim()}`,
    meta.length ? `> ${meta.join(' · ')}` : '',
    wechatArticleBodyToMarkdown(article.contentHtml),
  ]
    .filter(Boolean)
    .join('\n\n')}\n`
}
