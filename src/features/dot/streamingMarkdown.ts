import type { Element, ElementContent, Root, RootContent } from 'hast'

// 流式输出时的两件事:
// 1. balanceStreamingMarkdown:回答停在半截时,把没合上的 ** 和 ` 临时补上(或去掉刚出现的开头),
//    免得先闪出一串星号、等后半段到了才变成粗体;
// 2. rehypeStreamingWords:把正文按词拆成 <span class="dot-word">,新出现的词从模糊里浮现(动画在 CSS),
//    末尾再放一个闪烁的光标。React 复用已有的 span,所以只有新到的词会播动画。

// 点点在粗体记号两侧垫零宽空格(U+200B),所以「刚开头的 **」后面可能跟着它
const OPENING_AT_END = /\*\*\u200b*$/

/** 只用于还在生成的回答;答完的回答原样渲染。 */
export function balanceStreamingMarkdown(text: string): string {
  // 末尾单独一个 *:多半是 ** 的前一半
  let out = text.replace(/(^|[^*])\*$/, '$1')
  const lastBlock = out.slice(out.lastIndexOf('\n\n') + 1)
  const bold = lastBlock.match(/\*\*/g)?.length ?? 0
  if (bold % 2 === 1) {
    // 粗体刚开头、还没有字:先不显示这个开头;已经有字了:临时合上
    out = OPENING_AT_END.test(out) ? out.replace(OPENING_AT_END, '') : `${out}**`
  }
  const ticks = out.slice(out.lastIndexOf('\n\n') + 1).match(/`/g)?.length ?? 0
  if (ticks % 2 === 1) out = `${out}\``
  return out
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null

function splitWords(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (part) => part.segment)
  return text.match(/\s+|[\u3400-\u9fff]|[^\s\u3400-\u9fff]+/g) ?? [text]
}

// 链接(配图出处)整块弹出,代码不拆
const KEEP_WHOLE = new Set(['a', 'code', 'pre'])
// 光标要放进最后一个装文字的块里,不是列表、表格这种外壳
const CONTAINERS = new Set(['ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'div'])

type Parent = Root | Element

function wrapWords(node: Parent) {
  const next: ElementContent[] = []
  for (const child of node.children as RootContent[]) {
    if (child.type === 'text') {
      if (!child.value.trim()) {
        next.push(child)
        continue
      }
      for (const word of splitWords(child.value)) {
        next.push(word.trim()
          ? { type: 'element', tagName: 'span', properties: { className: ['dot-word'] }, children: [{ type: 'text', value: word }] }
          : { type: 'text', value: word })
      }
      continue
    }
    if (child.type === 'element' && !KEEP_WHOLE.has(child.tagName)) wrapWords(child)
    if (child.type === 'element' || child.type === 'comment') next.push(child)
  }
  node.children = next
}

function lastTextBlock(node: Parent): Parent {
  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const child = node.children[index]
    if (child.type === 'text' && !child.value.trim()) continue
    if (child.type === 'element' && (CONTAINERS.has(child.tagName) || /^(p|h[1-6]|td|th)$/.test(child.tagName))) {
      return lastTextBlock(child)
    }
    return node
  }
  return node
}

export function rehypeStreamingWords(options: { caret?: boolean } = {}) {
  return (tree: Root) => {
    wrapWords(tree)
    if (options.caret) {
      lastTextBlock(tree).children.push({
        type: 'element', tagName: 'span', properties: { className: ['dot-caret'], ariaHidden: 'true' }, children: [],
      })
    }
  }
}
