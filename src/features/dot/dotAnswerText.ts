// 点点的回答里夹着它自己网页用的 HTML 图片块:
//   <div class="ai-msg-image-item" data-index="1"><img src="…" data-noteId="…" data-sourceNickname="…" /></div>
// 爪爪不渲染外来 HTML,把这些图片块换成指向原笔记的链接(连着的几张并成一行),其余标签去掉。

const NOTE_ID = /^[0-9a-f]{24}$/i
const IMAGE_ITEM = /<div\b[^>]*\bclass="ai-msg-image-item"[^>]*>([\s\S]*?)<\/div>/gi
// 正在流式输出时,最后一个图片块可能还没收全
const UNFINISHED_IMAGE_ITEM = /<div\b[^>]*\bclass="ai-msg-image-item"[\s\S]*$/i
const MARK = '\u0000'
const TOKEN = new RegExp(`${MARK}([0-9a-f]{24})\\|([^${MARK}]*)${MARK}`, 'gi')
const TOKEN_RUN = new RegExp(`${MARK}[^${MARK}]*${MARK}(?:\\s*${MARK}[^${MARK}]*${MARK})*`, 'g')

function attribute(source: string, name: string): string {
  return new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(source)?.[1]?.trim() ?? ''
}

function imageToken(inner: string): string {
  const noteId = attribute(inner, 'data-noteId')
  if (!NOTE_ID.test(noteId)) return ''
  const nickname = attribute(inner, 'data-sourceNickname').replace(/[[\]|\u0000]/g, '')
  return `${MARK}${noteId}|${nickname}${MARK}`
}

/** 点点回答 → 可以交给 markdown 渲染的正文。 */
export function prepareDotMarkdown(text: string): string {
  const tokens = text
    .replace(IMAGE_ITEM, (_, inner: string) => imageToken(inner))
    .replace(UNFINISHED_IMAGE_ITEM, '')
    .replace(/<\/?div\b[^>]*>/gi, '')
    // 还没收全的标签(流式输出时会在末尾出现半截)
    .replace(/<[a-z/][^>]*$/i, '')
  return tokens
    .replace(TOKEN_RUN, (run) => {
      const links = [...run.matchAll(TOKEN)].map(([, noteId, nickname]) =>
        `[配图 · ${nickname || '原笔记'}](https://www.xiaohongshu.com/explore/${noteId})`)
      return `\n\n${links.join('　')}\n\n`
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
