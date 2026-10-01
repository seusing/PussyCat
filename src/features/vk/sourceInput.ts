// 视频解析链接框的输入整理:把任意粘贴/输入的文本规整成「一条一个来源」。
//
// 来源只有三类:http(s) 链接、本地绝对路径、`upload:` 引用。聊天软件多选复制会带上
// 发送人和时间,分享文案会带上标题和说明,这些都不是来源。

const VERBATIM_LINE = /^(?:upload:|[A-Za-z]:[\\/]|\\\\|\/)/
// 链接到空白或中日文标点/引号为止:这些字符不会以未转义形式出现在 URL 里。
const LINK_PATTERN = /https?:\/\/[^\s‘-”…　-〿＀-￯]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/

export function extractSources(text: string): { sources: string[]; dropped: number } {
  const sources = new Set<string>()
  let dropped = 0
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (VERBATIM_LINE.test(line)) {
      sources.add(line)
      continue
    }
    const links = line.match(LINK_PATTERN)
    if (!links) {
      dropped += 1
      continue
    }
    for (const link of links) sources.add(link.replace(TRAILING_PUNCTUATION, ''))
  }
  return { sources: [...sources], dropped }
}

/** 粘贴文本里除了来源还有别的内容时,返回清理后的结果;没有可用来源,或文本本来就干净,返回 null。 */
export function cleanPastedSources(text: string): { sources: string[]; dropped: number } | null {
  const result = extractSources(text)
  if (result.sources.length === 0) return null
  const kept = new Set(result.sources)
  const alreadyClean = result.dropped === 0
    && text.split(/\r?\n/).every((line) => !line.trim() || kept.has(line.trim()))
  return alreadyClean ? null : result
}
