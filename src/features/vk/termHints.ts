// 笔记里的术语提示:产物解析、按视频取数,以及在 Markdown 渲染链路上给术语打标记的 rehype 插件。
// 术语由引擎筛选并排好优先级;这里只负责读出来、挑出笔记里出现的前几个、标第一次出现的位置。
import { normalizeTerm } from '../../data/knownTerms'
import { fetchVkJob, fetchVkOutputText } from '../../host/vkClient'

export { normalizeTerm }

export type VkTermHint = {
  term: string
  explanation: string
  /** 这个术语在该视频里的具体含义。 */
  in_video: string
  score?: number
  /** 故事线汇总的术语带着来源视频,卡片上据此写「在《…》里」。 */
  job_id?: string
  video_title?: string
}

export type VkTermHints = {
  terms: VkTermHint[]
  /** 术语没有经过 Jev 筛选时的说明,显示在卡片底部。 */
  note: string | null
}

export const TERM_HINT_LIMIT = 5

const QUICK_SUMMARY_SCHEMA = 'quick_summary_artifact'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTerm(item: unknown): VkTermHint[] {
  if (!isRecord(item)) return []
  const term = typeof item.term === 'string' ? item.term.trim() : ''
  const explanation = typeof item.explanation === 'string' ? item.explanation.trim() : ''
  if (!term || !explanation) return []
  return [{
    term,
    explanation,
    in_video: typeof item.in_video === 'string' ? item.in_video.trim() : '',
    ...(typeof item.score === 'number' && Number.isFinite(item.score) ? { score: item.score } : {}),
  }]
}

function selectionNote(selection: unknown): string | null {
  if (!isRecord(selection) || selection.method !== 'fallback') return null
  const reason = typeof selection.reason === 'string' ? selection.reason.trim() : ''
  return reason ? `未经 Jev 筛选：${reason}` : '未经 Jev 筛选'
}

/** 快速摘要产物 JSON(1.4.0 起)里的术语;旧版本没有这些字段,坏数据一律当作没有术语。 */
export function termHintsFromArtifact(json: unknown): VkTermHints {
  if (!isRecord(json) || !Array.isArray(json.terms)) return { terms: [], note: null }
  return { terms: json.terms.flatMap(parseTerm), note: selectionNote(json.term_selection) }
}

/**
 * 读某个视频任务的术语。没有快速摘要产物(或是旧版本产物)是确定的「没有术语」;
 * 请求或解析出错返回 null,调用方下次还可以再试。
 */
export async function loadVkTermHints(jobId: string, baseUrl?: string): Promise<VkTermHints | null> {
  try {
    const job = await fetchVkJob(jobId, baseUrl)
    const artifact = job.outputs?.product_artifacts?.find((item) => item.schema_name === QUICK_SUMMARY_SCHEMA)
    if (!artifact?.json) return { terms: [], note: null }
    return termHintsFromArtifact(JSON.parse(await fetchVkOutputText(artifact.json, baseUrl)))
  } catch {
    return null
  }
}

// —— rehype 插件 ——
// 只用到 hast 的 root/element/text 三种节点,这里按用到的形状自备类型,不依赖传递依赖里的 @types/hast。
type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }
type TextSlot = { parent: HastNode; node: HastNode }
type TermHit = { slot: TextSlot; start: number; end: number }

export type TermHintOptions = {
  /** 按优先级排好的术语。 */
  terms: readonly VkTermHint[]
  /** 已了解的术语,写法同 normalizeTerm。 */
  known: ReadonlySet<string>
  limit?: number
}

const SKIPPED_TAGS = new Set(['pre', 'code', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const ASCII_ALNUM = /[A-Za-z0-9]/

function collectTextSlots(parent: HastNode, slots: TextSlot[]): void {
  for (const node of parent.children ?? []) {
    if (node.type === 'text' && typeof node.value === 'string') slots.push({ parent, node })
    else if (node.type === 'element' && !SKIPPED_TAGS.has(node.tagName ?? '')) collectTextSlots(node, slots)
  }
}

// 英文缩写(RPE)不能从别的单词里切出来(sharpen),所以首尾是英数字符的术语要求两侧不是英数字符;
// 紧贴汉字不算(「用RPE衡量」)。
function termPattern(text: string): string {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const head = ASCII_ALNUM.test(text[0]) ? '(?<![A-Za-z0-9])' : ''
  const tail = ASCII_ALNUM.test(text[text.length - 1]) ? '(?![A-Za-z0-9])' : ''
  return `(${head}${escaped}${tail})`
}

/** 候选术语各自在可标注文本里第一次出现的位置;合并成一个正则,长的先试,所以最长匹配优先。 */
function firstHits(slots: TextSlot[], candidates: number[], texts: readonly string[]): Map<number, TermHit> {
  const ordered = [...candidates].sort((left, right) => texts[right].length - texts[left].length)
  const pattern = new RegExp(ordered.map((index) => termPattern(texts[index])).join('|'), 'gi')
  const hits = new Map<number, TermHit>()
  for (const slot of slots) {
    const value = slot.node.value as string
    pattern.lastIndex = 0
    for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
      const index = ordered[match.findIndex((group, position) => position > 0 && group !== undefined) - 1]
      if (!hits.has(index)) hits.set(index, { slot, start: match.index, end: match.index + match[0].length })
    }
    if (hits.size === ordered.length) break
  }
  return hits
}

function splitWithTerms(value: string, marks: Array<{ start: number; end: number; index: number }>): HastNode[] {
  const pieces: HastNode[] = []
  let cursor = 0
  for (const { start, end, index } of marks) {
    if (start > cursor) pieces.push({ type: 'text', value: value.slice(cursor, start) })
    pieces.push({
      type: 'element',
      tagName: 'span',
      properties: { className: ['vk-term'], dataTermId: String(index) },
      children: [{ type: 'text', value: value.slice(start, end) }],
    })
    cursor = end
  }
  if (cursor < value.length) pieces.push({ type: 'text', value: value.slice(cursor) })
  return pieces
}

/**
 * 给笔记里的术语包上 `span.vk-term[data-term-id]`(id 是术语在 terms 里的下标)。
 * 先按优先级挑出笔记里出现过、且没被标记为已了解的前 limit 个,再各标第一次出现的位置。
 * 代码块、行内代码、链接和标题里的文字不标。
 */
export function rehypeTermHints({ terms, known, limit = TERM_HINT_LIMIT }: TermHintOptions) {
  return (tree: HastNode): void => {
    const texts = terms.map((hint) => (typeof hint.term === 'string' ? hint.term.trim() : ''))
    const seen = new Set<string>()
    const candidates: number[] = []
    texts.forEach((text, index) => {
      const key = normalizeTerm(text)
      if (!key || known.has(key) || seen.has(key)) return
      seen.add(key)
      candidates.push(index)
    })
    if (candidates.length === 0 || limit <= 0) return

    const slots: TextSlot[] = []
    collectTextSlots(tree, slots)
    const selected = [...firstHits(slots, candidates, texts).keys()].sort((left, right) => left - right).slice(0, limit)
    if (selected.length === 0) return

    const marksBySlot = new Map<TextSlot, Array<{ start: number; end: number; index: number }>>()
    for (const [index, { slot, start, end }] of firstHits(slots, selected, texts)) {
      marksBySlot.set(slot, [...(marksBySlot.get(slot) ?? []), { start, end, index }])
    }
    const replacements = new Map<HastNode, HastNode[]>()
    for (const [slot, marks] of marksBySlot) {
      replacements.set(slot.node, splitWithTerms(slot.node.value as string, marks.sort((left, right) => left.start - right.start)))
    }
    for (const parent of new Set([...marksBySlot.keys()].map((slot) => slot.parent))) {
      parent.children = (parent.children ?? []).flatMap((child) => replacements.get(child) ?? [child])
    }
  }
}
