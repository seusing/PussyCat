import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import { positionMenu, useGlassMenuSurface } from '../../components/GlassMenu'
import { addKnownTerm, loadKnownTerms, normalizeTerm } from '../../data/knownTerms'
import { NOTE_REMARK_PLUGINS, noteUrlTransform } from '../../lib/noteMarkdown'
import { CHART_SRC, MarketChart } from './MarketChart'
import { NoteBlockquote, NoteParagraph } from './NoteEvidence'
import { FIGURE_SRC, listNoteFigureNames, NoteFigure, NoteFigureGalleryContext } from './NoteFigure'
import { rehypeTermHints, TERM_HINT_LIMIT, type VkTermHint } from './termHints'
import './TermHint.css'

const CLOSE_DELAY_MS = 160

type CardPosition = ReturnType<typeof positionMenu>

/**
 * 笔记里一个术语的触发点和悬停卡片。
 * 交互同任务详情里的「重新解析」菜单:悬停或聚焦打开,离开 160ms 后关闭;点击或回车固定;
 * Esc 或点击外部关闭。
 */
export function TermHint({ hint, note, onKnown, children }: {
  hint: VkTermHint
  note: string | null
  onKnown: (term: string) => void
  children: ReactNode
}) {
  const cardId = useId()
  const reduceMotion = useReducedMotion()
  const triggerRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const knownButtonRef = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<number | null>(null)
  const pinned = useRef(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CardPosition | null>(null)
  useGlassMenuSurface(cardRef, open)

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  const openCard = useCallback(() => {
    clearCloseTimer()
    setOpen(true)
  }, [clearCloseTimer])

  const closeCard = useCallback(() => {
    clearCloseTimer()
    pinned.current = false
    setOpen(false)
  }, [clearCloseTimer])

  const scheduleClose = useCallback(() => {
    if (pinned.current) return
    clearCloseTimer()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }, [clearCloseTimer])

  useEffect(() => clearCloseTimer, [clearCloseTimer])

  useLayoutEffect(() => {
    if (open && triggerRef.current && cardRef.current) setPosition(positionMenu(triggerRef.current, cardRef.current))
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const reposition = () => {
      if (triggerRef.current && cardRef.current) setPosition(positionMenu(triggerRef.current, cardRef.current))
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && (triggerRef.current?.contains(target) || cardRef.current?.contains(target))) return
      closeCard()
    }
    // 结果窗口自己监听 Esc 来关整个窗口,而 React 的 portal 事件会冒泡进去。
    // 在 document 捕获阶段先拦下,焦点在哪都只关卡片。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      // 先还焦点再关:触发点的 onFocus 会打开卡片,随后的关闭把它盖掉。
      if (cardRef.current?.contains(document.activeElement)) triggerRef.current?.focus({ preventScroll: true })
      closeCard()
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, closeCard])

  const togglePinned = (focusCard: boolean) => {
    if (pinned.current) {
      closeCard()
      return
    }
    pinned.current = true
    openCard()
    // 键盘用户 Tab 不进 portal 里的卡片,固定后把焦点直接给「我已了解」。
    if (focusCard) requestAnimationFrame(() => knownButtonRef.current?.focus({ preventScroll: true }))
  }

  const contextLabel = hint.video_title ? `在《${hint.video_title}》里：` : '在这个视频里：'
  const cardStyle: CSSProperties = position
    ? { top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }
    : { top: 0, left: 0, visibility: 'hidden' }

  return (
    <>
      <span
        ref={triggerRef}
        className="vk-term"
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={open ? cardId : undefined}
        onMouseEnter={openCard}
        onMouseLeave={scheduleClose}
        onFocus={openCard}
        onBlur={(event) => {
          if (!cardRef.current?.contains(event.relatedTarget as Node | null)) scheduleClose()
        }}
        onClick={() => togglePinned(false)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.repeat) return
          event.preventDefault()
          togglePinned(true)
        }}
      >{children}</span>
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={cardRef}
              key="term-card"
              id={cardId}
              role="dialog"
              aria-label={`术语：${hint.term}`}
              className="vk-term-card glass-menu-surface glass-menu-effect"
              style={cardStyle}
              onMouseEnter={openCard}
              onMouseLeave={scheduleClose}
              onBlur={(event) => {
                const next = event.relatedTarget
                if (next instanceof Node && !cardRef.current?.contains(next) && !triggerRef.current?.contains(next)) closeCard()
              }}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0, pointerEvents: 'auto' }}
              exit={{ opacity: 0, y: 4, pointerEvents: 'none' }}
              transition={{ duration: reduceMotion ? 0 : 0.14 }}
            >
              <div className="glass-menu-content vk-term-card-body">
                <strong className="vk-term-card-term">{hint.term}</strong>
                <p>{hint.explanation}</p>
                {hint.in_video && <p className="vk-term-card-context">{`${contextLabel}${hint.in_video}`}</p>}
                {note && <p className="vk-term-card-note">{note}</p>}
                <button
                  ref={knownButtonRef}
                  type="button"
                  className="vk-term-card-known"
                  onClick={() => { onKnown(hint.term); closeCard() }}
                >我已了解</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}

type TermHintContextValue = {
  terms: readonly VkTermHint[]
  note: string | null
  onKnown: (term: string) => void
  /** 配图和行情图所在的任务;没有时笔记里的 figures/、charts/ 引用不解析,按普通图片渲染。 */
  figure: { jobId: string; baseUrl?: string } | null
}

const TermHintContext = createContext<TermHintContextValue | null>(null)

// react-markdown 的 span 覆盖:只有 rehypeTermHints 标出来的 span 换成 TermHint,其余原样输出。
function TermHintSpan({ node: _node, ...props }: ComponentProps<'span'> & ExtraProps) {
  const context = useContext(TermHintContext)
  const isTerm = props.className?.split(' ').includes('vk-term')
  const id = isTerm ? Number((props as Record<string, unknown>)['data-term-id']) : NaN
  const hint = context?.terms[id]
  if (!context || !hint) return <span {...props} />
  // key 跟着术语走:点「我已了解」后后面的 span 会顶上这个位置,不能继承前一个术语的卡片状态。
  return <TermHint key={id} hint={hint} note={context.note} onKnown={context.onKnown}>{props.children}</TermHint>
}

// react-markdown 的 img 覆盖:figures/<name>.jpg 走 NoteFigure,charts/<name>.json 走 MarketChart(都要有任务可查),
// 其余图片原样输出。
function NoteImage({ node: _node, ...props }: ComponentProps<'img'> & ExtraProps) {
  const figure = useContext(TermHintContext)?.figure
  const src = typeof props.src === 'string' ? props.src : undefined
  const figureName = src ? FIGURE_SRC.exec(src)?.[1] : undefined
  const chartName = src ? CHART_SRC.exec(src)?.[1] : undefined
  if (figure && figureName) return <NoteFigure jobId={figure.jobId} baseUrl={figure.baseUrl} name={figureName} alt={props.alt ?? ''} />
  if (figure && chartName) return <MarketChart jobId={figure.jobId} baseUrl={figure.baseUrl} name={chartName} alt={props.alt ?? ''} />
  return <img {...props} />
}

const TERM_HINT_COMPONENTS: Components = { span: TermHintSpan, img: NoteImage, blockquote: NoteBlockquote, p: NoteParagraph }

/**
 * 渲染笔记 Markdown,并给 terms 里的术语(最多 TERM_HINT_LIMIT 个、已了解的除外)挂上悬停卡片。
 * 传 figureJobId 时,笔记里的 figures/ 配图和 charts/ 行情图按该任务取回显示;同一篇笔记的配图在灯箱里连着翻页。
 */
export function TermHintMarkdown({ children, terms, note, figureJobId, baseUrl }: {
  children: string
  terms: readonly VkTermHint[]
  note: string | null
  figureJobId?: string
  baseUrl?: string
}) {
  const [known, setKnown] = useState(() => loadKnownTerms())
  const markKnown = useCallback((term: string) => {
    addKnownTerm(term)
    setKnown((current) => new Set(current).add(normalizeTerm(term)))
  }, [])
  const context = useMemo(
    () => ({ terms, note, onKnown: markKnown, figure: figureJobId ? { jobId: figureJobId, baseUrl } : null }),
    [terms, note, markKnown, figureJobId, baseUrl],
  )
  const gallery = useMemo(() => ({ names: listNoteFigureNames(children), urls: new Map() }), [children])
  return (
    <TermHintContext.Provider value={context}>
      <NoteFigureGalleryContext.Provider value={gallery}>
        <Markdown
          remarkPlugins={NOTE_REMARK_PLUGINS}
          rehypePlugins={[[rehypeTermHints, { terms, known, limit: TERM_HINT_LIMIT }]]}
          components={TERM_HINT_COMPONENTS}
          skipHtml
          urlTransform={noteUrlTransform}
        >{children}</Markdown>
      </NoteFigureGalleryContext.Provider>
    </TermHintContext.Provider>
  )
}
