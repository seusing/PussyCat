import type { ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'
import './NoteEvidence.css'

type HastElement = NonNullable<ExtraProps['node']>
type HastNode = HastElement['children'][number]

const SOURCE_CHECK_PREFIX = '来源核对 ·'
const OPINION_LINE = '博主观点'

/** 核对结论到徽标色调:一致绿、有出入橙、未找到出处灰。 */
const VERDICT_TONES = { 一致: 'consistent', 有出入: 'conflict', 未找到出处: 'missing' } as const
type Verdict = keyof typeof VERDICT_TONES

type CheckedSource = { title: string; url: string | null; meta: string }
type SourceCheck = { verdict: Verdict; sources: CheckedSource[] }

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(textOf).join('')
  return ''
}

const isVerdict = (value: string): value is Verdict => Object.hasOwn(VERDICT_TONES, value)

/**
 * 解析段落 `来源核对 · 一致：[标题](url) · 媒体 · 日期；[标题](url) · 媒体 · 日期`。
 * 不是核对行、或结论不在三种之内时返回 null,由调用方按普通段落渲染。
 */
function parseSourceCheck(paragraph: HastElement): SourceCheck | null {
  const [head, ...rest] = paragraph.children
  if (head?.type !== 'text' || !head.value.startsWith(SOURCE_CHECK_PREFIX)) return null
  const firstLine = head.value.slice(SOURCE_CHECK_PREFIX.length).split('\n', 1)[0]
  const verdict = firstLine.split(/[：:]/, 1)[0].trim()
  if (!isVerdict(verdict)) return null

  const sources: CheckedSource[] = []
  let current: CheckedSource | null = null
  for (const node of rest) {
    if (node.type === 'element' && node.tagName === 'a') {
      const href = typeof node.properties.href === 'string' ? node.properties.href : ''
      current = { title: textOf(node), url: /^https?:\/\//i.test(href) ? href : null, meta: '' }
      sources.push(current)
    } else if (node.type === 'text') {
      // 换行之后是别的行(例如「博主观点」),不属于来源。
      const [line, ...laterLines] = node.value.split('\n')
      line.split('；').forEach((part, index) => {
        if (index > 0) current = null
        if (current) current.meta += part
      })
      if (laterLines.length > 0) break
    }
  }
  return { verdict, sources }
}

/** 引擎在关键点下面写的两种行:来源核对(一行)和「博主观点」(单独一行,也可能紧跟在核对行后面)。 */
function evidenceOf(paragraph: HastElement): { check: SourceCheck | null; opinion: boolean } | null {
  const lines = textOf(paragraph).split('\n').map((line) => line.trim()).filter(Boolean)
  const check = parseSourceCheck(paragraph)
  const opinion = lines.includes(OPINION_LINE)
  return check || (opinion && lines.length === 1) ? { check, opinion } : null
}

function SourceCheckCard({ check }: { check: SourceCheck }) {
  return (
    <div className="vk-source-check" role="note" aria-label="来源核对">
      <div className="vk-source-check-head">
        <span>来源核对</span>
        <span className={`vk-source-badge is-${VERDICT_TONES[check.verdict]}`}>{check.verdict}</span>
      </div>
      {check.sources.length > 0 && (
        <ul className="vk-source-list">
          {check.sources.map((source, index) => {
            const meta = source.meta.split('·').map((part) => part.trim()).filter(Boolean).join(' · ')
            return (
              <li key={index}>
                {source.url
                  ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
                  : <span>{source.title}</span>}
                {meta && <span className="vk-source-meta">{meta}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function OpinionTag() {
  return <span className="vk-opinion-tag">{OPINION_LINE}</span>
}

/** react-markdown 的 p 覆盖:来源核对行渲染成卡片、「博主观点」行渲染成标签,其余段落原样输出。 */
export function NoteParagraph({ node, children, ...props }: ComponentProps<'p'> & ExtraProps) {
  const evidence = node ? evidenceOf(node) : null
  if (!evidence) return <p {...props}>{children}</p>
  return (
    <>
      {evidence.check && <SourceCheckCard check={evidence.check} />}
      {evidence.opinion && <OpinionTag />}
    </>
  )
}

/**
 * react-markdown 的 blockquote 覆盖:引用里只有来源核对行和「博主观点」行时去掉引用外壳
 * (卡片和标签自己有样式);和原话引用混在一起时保留引用,卡片留在里面。
 */
export function NoteBlockquote({ node, children, ...props }: ComponentProps<'blockquote'> & ExtraProps) {
  const blocks = node?.children.filter((child): child is HastElement => child.type === 'element') ?? []
  if (blocks.length > 0 && blocks.every((block) => block.tagName === 'p' && evidenceOf(block))) return <>{children}</>
  return <blockquote {...props}>{children}</blockquote>
}
