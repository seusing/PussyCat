import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { SendHorizontal, Square, SquarePen } from 'lucide-react'
import { DotAnswer } from './DotAnswer'
import { useDotChat } from './dotChatStore'
import './DotChatPanel.css'

const EXAMPLE_QUESTION = '推荐几条讲手机剪辑技巧的视频笔记'

export function DotChatPanel() {
  const turns = useDotChat((state) => state.turns)
  const busy = useDotChat((state) => state.activeRunId !== null)
  const ask = useDotChat((state) => state.ask)
  const stop = useDotChat((state) => state.stop)
  const regenerate = useDotChat((state) => state.regenerate)
  const newConversation = useDotChat((state) => state.newConversation)
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // 跟着回答往下滚;用户往上翻看时不打扰
  useEffect(() => {
    const list = listRef.current
    if (list && pinnedRef.current) list.scrollTop = list.scrollHeight
  }, [turns])

  const submit = () => {
    const question = draft.trim()
    if (!question || busy) return
    pinnedRef.current = true
    ask(question)
    setDraft('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="dot-chat" data-testid="dot-chat">
      <div className="dot-chat-toolbar">
        <button type="button" data-testid="dot-new-conversation" onClick={newConversation} disabled={busy || turns.length === 0}>
          <SquarePen size={14} aria-hidden="true" />新对话
        </button>
      </div>
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
              <button type="button" onClick={() => ask(EXAMPLE_QUESTION)}>{EXAMPLE_QUESTION}</button>
            </div>
          )
          : turns.map((turn, index) => (
            <DotAnswer key={turn.id} turn={turn} isLast={index === turns.length - 1} onRegenerate={regenerate} />
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
        {busy
          ? (
            <button type="button" className="dot-chat-stop" data-testid="dot-chat-stop" onClick={stop}>
              <Square size={13} aria-hidden="true" />停止
            </button>
          )
          : (
            <button type="submit" className="dot-chat-send" data-testid="dot-chat-send" disabled={!draft.trim()}>
              <SendHorizontal size={14} aria-hidden="true" />发送
            </button>
          )}
      </form>
      <footer className="dot-chat-footer">点点用你在 Chrome 里登录的小红书账号回答，看不到你的收藏和点赞；请像平时一样适度提问</footer>
    </div>
  )
}
