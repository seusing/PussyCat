import { useState } from 'react'
import { ChevronDown, Clapperboard, ExternalLink } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { DOT_CHAT_COMMAND, type DotReference } from './dotProtocol'

/** 点点引用的一篇笔记:默认只显示标题一行,点开看引用原文和操作。 */
export function DotReferenceCard({ item }: { item: DotReference }) {
  const [open, setOpen] = useState(false)
  const setVkHandoff = useAppStore((state) => state.setVkHandoff)
  return (
    <li className={`dot-ref${open ? ' is-open' : ''}`} data-testid={`dot-ref-${item.noteId}`}>
      <button type="button" className="dot-ref-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {item.noteType && <span className="dot-ref-type">{item.noteType === 'video' ? '视频' : '图文'}</span>}
        <span className="dot-ref-title">{item.title || '无标题笔记'}</span>
        {item.author && <span className="dot-ref-author">{item.author}</span>}
        <ChevronDown size={14} className="dot-ref-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="dot-ref-body">
          {item.quote && <p className="dot-ref-quote">{item.quote}</p>}
          <div className="dot-ref-actions">
            <a href={item.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={13} aria-hidden="true" />打开原文
            </a>
            {item.noteType === 'video' && (
              <button
                type="button"
                data-testid={`dot-ref-send-${item.noteId}`}
                onClick={() => setVkHandoff({ url: item.url, commandKey: DOT_CHAT_COMMAND, collectedAt: Date.now() })}
              >
                <Clapperboard size={13} aria-hidden="true" />送去视频解析
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}
