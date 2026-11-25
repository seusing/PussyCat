import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Pluggable } from 'unified'
import { Loader2, RotateCcw } from 'lucide-react'
import { CopyButton } from '../../components/CopyButton'
import { DotReferenceCard } from './DotReferenceCard'
import { prepareDotMarkdown } from './dotAnswerText'
import type { DotTurn } from './dotChatStore'
import { useTypewriter } from './useTypewriter'

// 点点的回答从不用缩进代码块;去掉 HTML 块后残留的缩进不该被当成代码显示
const remarkNoIndentedCode: Pluggable = function (this: { data: () => object }) {
  const data = this.data() as { micromarkExtensions?: unknown[] }
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), { disable: { null: ['codeIndented'] } }]
} as Pluggable

const REMARK_PLUGINS: Pluggable[] = [remarkGfm, remarkNoIndentedCode]
// 回答里的链接在系统浏览器里打开,不在爪爪窗口里跳走
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
}

/** 过程步骤:默认收起,只露最新一步;点开看全部。 */
function DotSteps({ steps, live, sourceTotal }: { steps: string[]; live: boolean; sourceTotal: string }) {
  if (steps.length === 0 && !(sourceTotal && !live)) return null
  const label = live ? steps[steps.length - 1] : (sourceTotal || `思考过程 · ${steps.length} 步`)
  return (
    <details className="dot-steps" data-testid="dot-steps">
      <summary>
        {live && <Loader2 size={13} className="dot-spin" aria-hidden="true" />}
        <span>{label}</span>
      </summary>
      {steps.length > 0 && (
        <ol>
          {steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      )}
    </details>
  )
}

export function DotAnswer({ turn, isLast, onRegenerate }: { turn: DotTurn; isLast: boolean; onRegenerate: () => void }) {
  const live = turn.state === 'waiting' || turn.state === 'streaming'
  const shown = useTypewriter(turn.answer, live, turn.state === 'stopped' || turn.state === 'error')
  return (
    <article className="dot-turn" data-testid="dot-turn" data-state={turn.state}>
      <div className="dot-turn-question">{turn.question}</div>
      <div className="dot-turn-answer">
        <DotSteps steps={turn.steps} live={live} sourceTotal={turn.sourceTotal} />
        {shown
          ? (
            <div className="dot-turn-markdown" data-testid="dot-answer">
              <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS} skipHtml>{prepareDotMarkdown(shown)}</Markdown>
            </div>
          )
          : live && turn.steps.length === 0 && (
            <div className="dot-turn-thinking"><Loader2 size={14} className="dot-spin" aria-hidden="true" />点点正在想…</div>
          )}
        {turn.state === 'stopped' && <span className="dot-turn-flag" data-testid="dot-stopped">已停止</span>}
        {turn.state === 'error' && <p className="dot-turn-error" role="alert">{turn.error}</p>}
        {turn.references.length > 0 && (
          <section className="dot-refs" aria-label="引用的笔记">
            <h3>引用 {turn.references.length} 篇笔记</h3>
            <ul>
              {turn.references.map((item) => <DotReferenceCard key={item.noteId} item={item} />)}
            </ul>
          </section>
        )}
        {isLast && !live && (
          <div className="dot-turn-actions">
            <button type="button" data-testid="dot-regenerate" onClick={onRegenerate}>
              <RotateCcw size={13} aria-hidden="true" />重新生成
            </button>
            {turn.answer && (
              <CopyButton label="复制回答" getText={() => prepareDotMarkdown(turn.answer)} testid="dot-copy" className="dot-turn-copy" />
            )}
          </div>
        )}
      </div>
    </article>
  )
}
