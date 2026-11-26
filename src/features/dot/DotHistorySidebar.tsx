import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PanelLeftClose, PanelLeftOpen, Search, SquarePen, X } from 'lucide-react'
import { selectLiveConversationId, useDotChat } from './dotChatStore'

/**
 * 一组行共用一块悬停高亮:鼠标在行间移动时,高亮滑过去而不是一行行闪。
 * 行用 data-row 标出;高亮的位置和高度直接写样式,不走 React 渲染。
 */
function GlideGroup({ children, className }: { children: ReactNode; className?: string }) {
  const highlightRef = useRef<HTMLSpanElement>(null)
  const move = (target: EventTarget | null) => {
    const highlight = highlightRef.current
    const row = target instanceof Element ? target.closest<HTMLElement>('[data-row]') : null
    if (!highlight) return
    if (!row || row.matches(':disabled')) {
      highlight.style.opacity = '0'
      return
    }
    highlight.style.transform = `translateY(${row.offsetTop}px)`
    highlight.style.height = `${row.offsetHeight}px`
    highlight.style.opacity = '1'
  }
  return (
    <div
      className={`dot-glide${className ? ` ${className}` : ''}`}
      onPointerOver={(event) => move(event.target)}
      onPointerLeave={() => move(null)}
    >
      <span ref={highlightRef} className="dot-glide-highlight" aria-hidden="true" />
      {children}
    </div>
  )
}

export type DotSidebarMode = 'open' | 'rail' | 'overlay'

/**
 * 点点的对话记录:新对话、搜索、按最近提问排的对话列表。
 * 宽屏时可收成一条图标栏;窄屏时默认是图标栏,展开后盖在对话上,选了对话就收回去。
 */
export function DotHistorySidebar({ narrow }: { narrow: boolean }) {
  const conversations = useDotChat((state) => state.conversations)
  const activeId = useDotChat((state) => state.activeId)
  const liveId = useDotChat(selectLiveConversationId)
  const history = useDotChat((state) => state.history)
  const newConversation = useDotChat((state) => state.newConversation)
  const openConversation = useDotChat((state) => state.openConversation)
  const retryHistory = useDotChat((state) => state.retryHistory)
  const [docked, setDocked] = useState(true)
  const [overlay, setOverlay] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const asideRef = useRef<HTMLElement>(null)

  const mode: DotSidebarMode = narrow ? (overlay ? 'overlay' : 'rail') : (docked ? 'open' : 'rail')
  const expanded = mode !== 'rail'

  useEffect(() => { if (!narrow) setOverlay(false) }, [narrow])
  useEffect(() => { if (searchOpen) searchRef.current?.focus() }, [searchOpen])
  // 盖在对话上时,点外面收回去
  useEffect(() => {
    if (mode !== 'overlay') return
    const close = (event: PointerEvent) => {
      if (!asideRef.current?.contains(event.target as Node)) setOverlay(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [mode])

  const sorted = useMemo(() => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt), [conversations])
  const needle = query.trim().toLowerCase()
  const visible = needle
    ? sorted.filter((conversation) => conversation.title.toLowerCase().includes(needle)
      || conversation.turns.some((turn) => turn.question.toLowerCase().includes(needle)))
    : sorted

  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
  }
  const expand = () => (narrow ? setOverlay(true) : setDocked(true))
  const collapse = () => {
    closeSearch()
    if (narrow) setOverlay(false)
    else setDocked(false)
  }
  const pick = (run: () => void) => {
    run()
    if (narrow) setOverlay(false)
  }

  return (
    <div className="dot-history-slot" data-mode={mode}>
      <aside ref={asideRef} className="dot-history" data-mode={mode} aria-label="点点对话记录" data-testid="dot-history">
        <div className="dot-history-top">
          {expanded
            ? (
              <button type="button" className="dot-history-icon" aria-label="收起对话记录" title="收起" onClick={collapse}>
                <PanelLeftClose size={17} aria-hidden="true" />
              </button>
            )
            : (
              <button type="button" className="dot-history-icon" aria-label="展开对话记录" title="展开对话记录" onClick={expand}>
                <PanelLeftOpen size={17} aria-hidden="true" />
              </button>
            )}
        </div>

        <GlideGroup>
          <button type="button" data-row className="dot-history-row" data-testid="dot-new-conversation" title="新对话"
            onClick={() => pick(newConversation)}>
            <SquarePen size={16} aria-hidden="true" />
            <span className="dot-history-copy">新对话</span>
          </button>
        </GlideGroup>

        <div className="dot-history-section" aria-hidden={!expanded}>
          <div className="dot-history-heading">
            <span className="dot-history-heading-label" data-hidden={searchOpen}>对话</span>
            <button type="button" className="dot-history-icon dot-history-search-trigger" aria-label="搜索对话" aria-expanded={searchOpen}
              tabIndex={expanded && !searchOpen ? 0 : -1} data-hidden={searchOpen} onClick={() => setSearchOpen(true)}>
              <Search size={15} aria-hidden="true" />
            </button>
            <div className="dot-history-search" data-open={searchOpen}>
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                tabIndex={searchOpen ? 0 : -1}
                placeholder="搜索对话"
                aria-label="搜索对话"
                data-testid="dot-history-search"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape') closeSearch() }}
              />
              <button type="button" aria-label="关闭搜索" tabIndex={searchOpen ? 0 : -1} onClick={closeSearch}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </div>

          <GlideGroup className="dot-history-list">
            {visible.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                data-row
                className={`dot-history-row${conversation.id === activeId ? ' is-active' : ''}`}
                data-testid={`dot-history-item-${conversation.id}`}
                aria-current={conversation.id === activeId ? 'true' : undefined}
                title={conversation.title}
                tabIndex={expanded ? 0 : -1}
                onClick={() => pick(() => openConversation(conversation.id))}
              >
                <span className="dot-history-copy">{conversation.title}</span>
                {conversation.id === liveId && <span className="dot-history-live" title="点点正在回答" />}
              </button>
            ))}
          </GlideGroup>
          {needle && visible.length === 0 && <p className="dot-history-note">没有找到</p>}
          {history.phase === 'loading' && sorted.length === 0 && <p className="dot-history-note">读取中…</p>}
          {history.phase === 'error' && (
            <div className="dot-history-note is-error" role="alert">
              <span title={history.error}>对话记录没读出来</span>
              <button type="button" onClick={retryHistory}>重试</button>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
