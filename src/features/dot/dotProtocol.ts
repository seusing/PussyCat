// 点点对话的事件协议。适配器(opencli-overrides/xiaohongshu-dot/chat.js)把进度写到 stderr,
// 一行一个 `@@zz-dot {json}`,宿主逐行实时转发;这里把它解析成界面用的内部事件。
// 点点页面变了只改适配器和这一层,界面只认这里的事件。

export const DOT_EVENT_PREFIX = '@@zz-dot '
export const DOT_CHAT_COMMAND = 'xiaohongshu-dot/chat'
export const DOT_STOP_COMMAND = 'xiaohongshu-dot/stop'
const CHAT_RUN_PREFIX = 'dot-chat:'
const STOP_RUN_PREFIX = 'dot-stop:'

export type DotReference = {
  noteId: string
  title: string
  author: string
  noteType: 'video' | 'normal' | ''
  url: string
  quote: string
}

export type DotEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'status'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'replace'; text: string }
  | { type: 'references'; items: DotReference[] }
  | { type: 'done'; sourceTotal: string; interrupted: boolean }
  | { type: 'error'; message: string }

export const dotChatRunId = (nonce: string) => `${CHAT_RUN_PREFIX}${nonce}`
export const dotStopRunId = (nonce: string) => `${STOP_RUN_PREFIX}${nonce}`
/** 点点对话发起的运行(提问和停止)都走点点自己的通道,不进运行面板。 */
export const isDotRunId = (runId: string) => runId.startsWith(CHAT_RUN_PREFIX) || runId.startsWith(STOP_RUN_PREFIX)
export const isDotStopRunId = (runId: string) => runId.startsWith(STOP_RUN_PREFIX)

const text = (value: unknown) => (typeof value === 'string' ? value : '')

function reference(value: unknown): DotReference | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const noteId = text(item.noteId)
  const url = text(item.url)
  if (!/^[0-9a-f]{24}$/i.test(noteId) || !url.startsWith('https://')) return null
  return {
    noteId,
    title: text(item.title),
    author: text(item.author),
    noteType: item.noteType === 'video' || item.noteType === 'normal' ? item.noteType : '',
    url,
    quote: text(item.quote),
  }
}

/** 解析一行输出;不是点点事件(例如 opencli 自己的警告)就返回 null。 */
export function parseDotLine(line: string): DotEvent | null {
  const trimmed = line.trimEnd()
  if (!trimmed.startsWith(DOT_EVENT_PREFIX)) return null
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(DOT_EVENT_PREFIX.length))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    data = parsed as Record<string, unknown>
  } catch {
    return null
  }
  switch (data.type) {
    case 'start':
      return { type: 'start', conversationId: text(data.conversationId), messageId: text(data.messageId) }
    case 'status':
      return text(data.text) ? { type: 'status', text: text(data.text) } : null
    case 'delta':
      return text(data.text) ? { type: 'delta', text: text(data.text) } : null
    case 'replace':
      return { type: 'replace', text: text(data.text) }
    case 'references': {
      const items = Array.isArray(data.items) ? data.items.map(reference).filter((item): item is DotReference => !!item) : []
      return { type: 'references', items }
    }
    case 'done':
      return { type: 'done', sourceTotal: text(data.sourceTotal), interrupted: data.interrupted === true }
    case 'error':
      return { type: 'error', message: text(data.message) || '点点这次没有答出来' }
    default:
      return null
  }
}
