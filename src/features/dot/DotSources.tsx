import { useState } from 'react'
import { ChevronDown, Clapperboard, ExternalLink } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { DOT_CHAT_COMMAND, type DotReference } from './dotProtocol'

// 作者头像:取昵称第一个字,底色按昵称固定挑一个(笔记封面图被应用的 CSP 挡着,不远程加载)
const AVATAR_COLORS = ['#3fb950', '#4f8cff', '#d29922', '#db61a2', '#39c5cf', '#a371f7', '#f0883e']

function avatarColor(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

export function DotAvatar({ name, size = 16 }: { name: string; size?: number }) {
  const label = name.trim() || '?'
  return (
    <span
      className="dot-avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.6), background: avatarColor(label) }}
    >
      {Array.from(label)[0]}
    </span>
  )
}

/** 引用的一篇笔记:一行标题,点开看引用原文和操作。 */
function DotReferenceRow({ item }: { item: DotReference }) {
  const [open, setOpen] = useState(false)
  const setVkHandoff = useAppStore((state) => state.setVkHandoff)
  return (
    <li className={`dot-ref${open ? ' is-open' : ''}`} data-testid={`dot-ref-${item.noteId}`}>
      <button type="button" className="dot-ref-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <DotAvatar name={item.author} />
        <span className="dot-ref-title">{item.title || '无标题笔记'}</span>
        {item.noteType && <span className="dot-ref-type">{item.noteType === 'video' ? '视频' : '图文'}</span>}
        {item.author && <span className="dot-ref-author">{item.author}</span>}
        <ChevronDown size={13} className="dot-ref-chevron" aria-hidden="true" />
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

/** 动作行里的出处按钮:几个作者头像叠在一起 +「N 篇笔记」。 */
export function DotSourcesToggle({ references, open, onToggle }: { references: DotReference[]; open: boolean; onToggle: () => void }) {
  const authors = [...new Set(references.map((item) => item.author || item.title))].slice(0, 4)
  return (
    <button type="button" className="dot-sources-toggle" data-testid="dot-sources-toggle" aria-expanded={open} onClick={onToggle}>
      <span className="dot-avatar-stack">
        {authors.map((name) => <DotAvatar key={name} name={name} size={15} />)}
      </span>
      <span>引用 {references.length} 篇笔记</span>
    </button>
  )
}

export function DotSourcesList({ references, open }: { references: DotReference[]; open: boolean }) {
  return (
    // 收起时用 visibility 藏住(CSS 里等收起动画放完再藏),里面的按钮不会被 Tab 到
    <div className="dot-sources" data-open={open} aria-hidden={!open}>
      <div className="dot-sources-inner">
        <ul aria-label="引用的笔记">
          {references.map((item) => <DotReferenceRow key={item.noteId} item={item} />)}
        </ul>
      </div>
    </div>
  )
}
