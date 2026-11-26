import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { SendHorizontal, Square } from 'lucide-react'
import { DotAnswer } from './DotAnswer'
import { DotHistorySidebar } from './DotHistorySidebar'
import { selectLiveConversationId, useActiveTurns, useDotChat } from './dotChatStore'
import './DotChatPanel.css'

const EXAMPLE_QUESTION = '推荐几条讲手机剪辑技巧的视频笔记'
// 面板窄于这个宽度时,对话记录收成图标栏,展开后盖在对话上
const NARROW_WIDTH = 760

function useNarrow(ref: RefObject<HTMLElement>): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0
      if (width > 0) setNarrow(width < NARROW_WIDTH)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return narrow
}

export function DotChatPanel() {
  const turns = useActiveTurns()
  const activeId = useDotChat((state) => state.activeId)
  const busy = useDotChat((state) => state.activeRunId !== null)
  const answeringHere = useDotChat((state) => {
    const liveId = selectLiveConversationId(state)
    return liveId !== null && liveId === state.activeId
  })
  const ask = useDotChat((state) => state.ask)
  const stop = useDotChat((state) => state.stop)
  const regenerate = useDotChat((state) => state.regenerate)
  const [draft, setDraft] = useState('')
  const layoutRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const narrow = useNarrow(layoutRef)

  // 换了对话就回到底部
  useEffect(() => {
    pinnedRef.current = true
  }, [activeId])
  // 跟着回答往下滚;用户往上翻看时不打扰
  useEffect(() => {
    const list = listRef.current
    if (list && pinnedRef.current) list.scrollTop = list.scrollHeight
  }, [turns, activeId])

  const submit = () => {
    const question = draft.trim()
    if (!question || busy) return
    pinnedRef.current = true
    ask(question)
    setDraft('')
  }

  const askNow = (question: string) => {
    pinnedRef.current = true
    ask(question)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div ref={layoutRef} className="dot-layout" data-narrow={narrow || undefined}>
      <DotHistorySidebar narrow={narrow} />
      <div className="dot-chat" data-testid="dot-chat">
        <div
          ref={listRef}
          className="dot-chat-list"
          data-testid="dot-chat-list"
          onScroll={(event) => {
            const list = event.currentTarget
            pinnedRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48
          }}
        >
          {turns.length === 0
            ? (
              <div className="dot-chat-empty" data-testid="dot-chat-empty">
                <p>想问点点什么？</p>
                <button type="button" disabled={busy} onClick={() => askNow(EXAMPLE_QUESTION)}>{EXAMPLE_QUESTION}</button>
              </div>
            )
            : turns.map((turn, index) => (
              <DotAnswer
                key={turn.id}
                turn={turn}
                isLast={index === turns.length - 1}
                busy={busy}
                onRegenerate={regenerate}
                onAsk={askNow}
              />
            ))}
        </div>
        <form
          className="dot-chat-composer"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <textarea
            data-testid="dot-chat-input"
            aria-label="问点点"
            placeholder="问点点"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {answeringHere
            ? (
              <button type="button" className="dot-chat-stop" data-testid="dot-chat-stop" onClick={stop}>
                <Square size={13} aria-hidden="true" />停止
              </button>
            )
            : (
              <button
                type="submit"
                className="dot-chat-send"
                data-testid="dot-chat-send"
                disabled={!draft.trim() || busy}
                title={busy ? '点点正在回答另一个对话' : undefined}
              >
                <SendHorizontal size={14} aria-hidden="true" />发送
              </button>
            )}
        </form>
        <footer className="dot-chat-footer">点点用你在 Chrome 里登录的小红书账号回答，看不到你的收藏和点赞；请像平时一样适度提问</footer>
      </div>
    </div>
  )
}
