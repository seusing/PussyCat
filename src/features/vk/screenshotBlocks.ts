// 图文笔记里原图手绘批注的块:`::screenshot{src="figures/<id>.jpg" …}` 起头、独占一行的 `::` 收尾,
// 块内是 `:::annotation{…}` 批注(comark-annotate 语法)。这里只做识别和切分,渲染见 AnnotatedFigure。

export type NoteSegment = { kind: 'markdown' | 'screenshot'; text: string }

const BLOCK_OPEN = '::screenshot{'
const BLOCK_CLOSE = '::'
// 反引号围栏的信息串里不能再有反引号,否则那行是行内代码。
const FENCE_OPEN = /^ {0,3}(?:(`{3,})[^`]*$|(~{3,}))/

/** 开头行里 `src="figures/<12 位十六进制>.jpg"` 的位置:捕获 [引号之前, 图片名, 引号]。 */
export const SCREENSHOT_FIGURE_SRC = /^(::screenshot\{(?:[^\n]*?\s)?src=")figures\/([0-9a-f]{12})\.jpg(")/gm

function closesFence(line: string, fence: { char: string; length: number }): boolean {
  const trimmed = line.trim()
  return trimmed.length >= fence.length && [...trimmed].every((char) => char === fence.char)
}

// 返回收尾行的下标;没有收尾(或收尾前又起了新块)返回 -1。
function findBlockEnd(lines: readonly string[], start: number): number {
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index].startsWith(BLOCK_OPEN)) return -1
    if (lines[index].trimEnd() === BLOCK_CLOSE) return index
  }
  return -1
}

/**
 * 把笔记切成按出现顺序排列的「普通 Markdown 段」和「::screenshot 块」,各段首尾相接即原文。
 * 没有收尾的块和代码块(``` 或 ~~~)里的块都留在普通段里。
 */
export function splitScreenshotBlocks(markdown: string): NoteSegment[] {
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const segments: NoteSegment[] = []
  let plain = ''
  let fence: { char: string; length: number } | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (fence) {
      if (closesFence(line, fence)) fence = null
      plain += line
      continue
    }
    const opened = FENCE_OPEN.exec(line)
    if (opened) {
      const marker = opened[1] ?? opened[2]
      fence = { char: marker[0], length: marker.length }
      plain += line
      continue
    }
    const end = line.startsWith(BLOCK_OPEN) ? findBlockEnd(lines, index) : -1
    if (end < 0) {
      plain += line
      continue
    }
    if (plain) segments.push({ kind: 'markdown', text: plain })
    plain = ''
    segments.push({ kind: 'screenshot', text: lines.slice(index, end + 1).join('') })
    index = end
  }
  if (plain || segments.length === 0) segments.push({ kind: 'markdown', text: plain })
  return segments
}

/** 折叠后块所在位置的围栏代码块信息串;react-markdown 的 pre 覆盖据此认出占位。 */
export const SCREENSHOT_FENCE = 'vk-screenshot'

/**
 * 把每个 ::screenshot 块换成一个占位围栏代码块(内容是块在 blocks 里的下标),其余原样不动。
 * 整篇笔记仍走同一棵 Markdown 树,术语提示的额度和「只标首次出现」按整篇算。
 */
export function foldScreenshotBlocks(markdown: string): { markdown: string; blocks: string[] } {
  const blocks: string[] = []
  const segments = splitScreenshotBlocks(markdown)
  if (segments.length === 1 && segments[0].kind === 'markdown') return { markdown, blocks }
  const folded = segments.map((segment) => (
    segment.kind === 'markdown' ? segment.text : `\`\`\`${SCREENSHOT_FENCE}\n${blocks.push(segment.text) - 1}\n\`\`\`\n`
  )).join('')
  return { markdown: folded, blocks }
}

function attribute(line: string, name: string): string | undefined {
  return new RegExp(`[\\s{]${name}="([^"]*)"`).exec(line)?.[1]
}

/** 读块开头行里的 src、alt 和 viewport(`宽x高`);缺的属性给空串或 null。 */
export function readScreenshotBlock(block: string): { src: string; alt: string; viewport: { width: number; height: number } | null } {
  const newline = block.indexOf('\n')
  const line = newline < 0 ? block : block.slice(0, newline)
  const viewport = /^(\d+)x(\d+)$/.exec(attribute(line, 'viewport') ?? '')
  return {
    src: attribute(line, 'src') ?? '',
    alt: attribute(line, 'alt') ?? '',
    viewport: viewport && Number(viewport[1]) > 0 && Number(viewport[2]) > 0
      ? { width: Number(viewport[1]), height: Number(viewport[2]) }
      : null,
  }
}
