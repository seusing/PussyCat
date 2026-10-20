import { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'

/** 笔记 Markdown 的共用解析:开头的 YAML 头只解析不渲染,表格等 GFM 语法照常。 */
export const NOTE_REMARK_PLUGINS = [remarkFrontmatter, remarkGfm]

// 导出到灵感库的笔记把配图内联成 data URI;默认转换会拦掉所有 data:,
// 这里只对 img 的 src 放行常见图片类型,其余 data: 和 javascript: 照旧被拦。
const INLINE_IMAGE_SRC = /^data:image\/(png|jpeg|webp|gif);base64,/i

export const noteUrlTransform: UrlTransform = (url, key, node) => {
  if (key === 'src' && node.tagName === 'img' && INLINE_IMAGE_SRC.test(url)) return url
  return defaultUrlTransform(url)
}
