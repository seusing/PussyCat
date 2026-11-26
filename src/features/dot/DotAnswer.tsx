import { useMemo, useState, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PluggableList } from 'unified'
import { CornerDownRight } from 'lucide-react'
import { RotateCcw } from 'lucide'
import { CopyButton } from '../../components/CopyButton'
import { IconActionButton } from '../../components/IconActionButton'
import { DotInsights } from './DotInsights'
import { DotAvatar, DotSourcesList, DotSourcesToggle } from './DotSources'
import { DotThinking } from './DotThinking'
import { prepareDotMarkdown } from './dotAnswerText'
import type { DotTurn } from './dotChatStore'
import { extractDotInsights } from './dotInsightData'
import { balanceStreamingMarkdown, rehypeStreamingWords } from './streamingMarkdown'
import { useTypewriter } from './useTypewriter'

// 点点的回答从不用缩进代码块;去掉 HTML 块后残留的缩进不该被当成代码显示
function remarkNoIndentedCode(this: { data: () => object }) {
  const data = this.data() as { micromarkExtensions?: unknown[] }
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), { disable: { null: ['codeIndented'] } }]
}

const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkNoIndentedCode]
const STREAMING_REHYPE_PLUGINS: PluggableList = [[rehypeStreamingWords, { caret: true }]]

// 回答里的配图(dotAnswerText 换成的「配图 · 作者」链接)显示成行内出处小标签
const IMAGE_SOURCE_LINK = /^https:\/\/www\.xiaohongshu\.com\/explore\/[0-9a-f]{24}$/i
const IMAGE_SOURCE_PREFIX = '配图 · '

const textOf = (children: ReactNode): string => (typeof children === 'string'
  ? children
  : Array.isArray(children) ? children.map(textOf).join('') : '')

// 链接一律 target="_blank":桌面壳里由 lib/externalLinks 交给系统浏览器
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => {
    const label = textOf(children)
    if (href && IMAGE_SOURCE_LINK.test(href) && label.startsWith(IMAGE_SOURCE_PREFIX)) {
      const name = label.slice(IMAGE_SOURCE_PREFIX.length)
      return (
        <a className="dot-chip" href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title="打开配图所在的笔记">
          <DotAvatar name={name} size={12} />
          <span>{name}</span>
        </a>
      )
    }
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  },
}

function DotFollowUps({ items, disabled, onAsk }: { items: string[]; disabled: boolean; onAsk: (text: string) => void }) {
  return (
    <section className="dot-follow-ups" aria-label="接着问">
      <h3>接着问</h3>
      {items.map((text, index) => (
        <button
          key={text}
          type="button"
          disabled={disabled}
          style={{ animationDelay: `${index * 90}ms` }}
          onClick={() => onAsk(text)}
        >
          <CornerDownRight size={12} aria-hidden="true" />
          {text}
        </button>
      ))}
    </section>
  )
}

export function DotAnswer({ turn, isLast, busy, onRegenerate, onAsk }: {
  turn: DotTurn
  isLast: boolean
  /** 点点正在回答(这一问或别的对话里的一问) */
  busy: boolean
  onRegenerate: () => void
  onAsk: (question: string) => void
}) {
  const live = turn.state === 'waiting' || turn.state === 'streaming'
  const shown = useTypewriter(turn.answer, live, turn.state === 'stopped' || turn.state === 'error')
  const [sourcesOpen, setSourcesOpen] = useState(false)
  // 数据洞察是从任意回答里按规则找数字,规则出岔子时宁可不出卡片,也不能让整段对话报错
  const insights = useMemo(() => {
    if (live) return []
    try {
      return extractDotInsights(turn.answer)
    } catch {
      return []
    }
  }, [live, turn.answer])
  const markdown = live ? balanceStreamingMarkdown(prepareDotMarkdown(shown)) : prepareDotMarkdown(shown)
  const hasReferences = turn.references.length > 0

  return (
    <article className="dot-turn" data-testid="dot-turn" data-state={turn.state}>
      <div className="dot-turn-question">{turn.question}</div>
      <div className="dot-turn-answer">
        <DotThinking turn={turn} />
        {markdown && (
          <div className="dot-turn-markdown" data-testid="dot-answer" data-streaming={live || undefined}>
            <Markdown
              remarkPlugins={REMARK_PLUGINS}
              rehypePlugins={live ? STREAMING_REHYPE_PLUGINS : undefined}
              components={MARKDOWN_COMPONENTS}
              skipHtml
            >
              {markdown}
            </Markdown>
          </div>
        )}
        {turn.state === 'stopped' && <span className="dot-turn-flag" data-testid="dot-stopped">已停止</span>}
        {turn.state === 'error' && <p className="dot-turn-error" role="alert">{turn.error}</p>}
        {insights.length > 0 && <DotInsights insights={insights} />}
        {!live && (turn.answer || hasReferences || isLast) && (
          <div className="dot-turn-actions">
            {turn.answer && (
              <CopyButton label="复制回答" getText={() => prepareDotMarkdown(turn.answer)} testid="dot-copy" />
            )}
            {isLast && (
              <IconActionButton icon={RotateCcw} label="重新生成" data-testid="dot-regenerate" disabled={busy} onClick={onRegenerate} />
            )}
            {hasReferences && (
              <DotSourcesToggle references={turn.references} open={sourcesOpen} onToggle={() => setSourcesOpen(!sourcesOpen)} />
            )}
          </div>
        )}
        {!live && hasReferences && <DotSourcesList references={turn.references} open={sourcesOpen} />}
        {isLast && turn.state === 'done' && turn.followUps.length > 0 && (
          <DotFollowUps items={turn.followUps} disabled={busy} onAsk={onAsk} />
        )}
      </div>
    </article>
  )
}
