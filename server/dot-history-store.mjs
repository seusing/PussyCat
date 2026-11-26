// 点点对话记录的本机文件存储:<dir>/history.json,整份读写(见 json-document-store.mjs),
// 由渲染进程持有内存副本、去抖后整份 PUT 过来(见 src/features/dot/dotChatStore.ts)。
import { createJsonDocumentStore, isRecord } from './json-document-store.mjs'

export const DOT_HISTORY_FILE_NAME = 'history.json'

// 只校验顶层结构和每个对话的核心字段;每一轮的细节由渲染进程读回时自己整理。
// 返回 null 表示通过,否则是第一处问题的描述。
export function dotHistoryProblem(history) {
  if (!isRecord(history)) return '顶层必须是对象'
  if (history.version !== 1) return 'version 必须是 1'
  if (!Array.isArray(history.conversations)) return 'conversations 必须是数组'
  for (const [index, conversation] of history.conversations.entries()) {
    if (!isRecord(conversation) || typeof conversation.id !== 'string' || !Array.isArray(conversation.turns)) {
      return `conversations[${index}] 缺少字符串字段 id 或数组字段 turns`
    }
  }
  return null
}

export function createDotHistoryStore(options = {}) {
  const store = createJsonDocumentStore({
    ...options,
    fileName: DOT_HISTORY_FILE_NAME,
    label: '点点对话记录',
    reasonPrefix: 'dot-history',
    problem: dotHistoryProblem,
  })
  return {
    maxBytes: store.maxBytes,
    file: store.file,
    async read() {
      const { document, ...rest } = await store.read()
      return { ...rest, history: document }
    },
    write: (history) => store.write(history),
  }
}
