// 点点对话记录:存在宿主上的文件里(server/dot-history-store.mjs),整份读写。
// 这里是存档格式、读回时的整理,以及跟宿主说话的客户端;什么时候存由 dotChatStore 决定。
import { HostRequestError } from '../../host/errors'
import { parseDotReference, parseFollowUps, type DotReference } from './dotProtocol'

export type DotTurnState = 'waiting' | 'streaming' | 'done' | 'stopped' | 'error'

export type DotTurn = {
  id: string
  question: string
  answer: string
  /** 点点的过程步骤(搜索、整理……),按出现顺序 */
  steps: string[]
  references: DotReference[]
  /** 点点给的出处说明,例如「ai总结 12 篇笔记生成」 */
  sourceTotal: string
  /** 点点给的「接着问」 */
  followUps: string[]
  state: DotTurnState
  error?: string
  /** 提问的时刻 */
  startedAt: number
  /** 第一段正文到达的时刻;思考用时 = answeredAt - startedAt */
  answeredAt?: number
  /** 回答结束(答完、停止、出错)的时刻 */
  finishedAt?: number
  /** 以下两项只在这次运行里有意义,不存档 */
  runId: string
  /** 点点被占用(视频解析的点点速览正在问)时已经排队重试了几次 */
  busyRetries: number
}

export type DotConversation = {
  id: string
  /** 点点那边的会话 id;接着问时带上它,点点按它续上下文 */
  remoteId: string | null
  /** 第一问 */
  title: string
  createdAt: number
  /** 最近一次提问的时刻,列表按它排 */
  updatedAt: number
  turns: DotTurn[]
}

type StoredTurn = Omit<DotTurn, 'runId' | 'busyRetries'>
export type DotHistoryFile = {
  version: 1
  conversations: Array<Omit<DotConversation, 'turns'> & { turns: StoredTurn[] }>
}

const STATES: readonly string[] = ['waiting', 'streaming', 'done', 'stopped', 'error']
const TITLE_MAX = 80

export const conversationTitle = (question: string) => question.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)

export function serializeDotHistory(conversations: DotConversation[]): DotHistoryFile {
  return {
    version: 1,
    conversations: conversations.map(({ turns, ...conversation }) => ({
      ...conversation,
      turns: turns.map(({ runId: _runId, busyRetries: _busyRetries, ...turn }) => turn),
    })),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown) => (typeof value === 'string' ? value : '')
const time = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : [])

function readTurn(raw: unknown): DotTurn | null {
  if (!isRecord(raw) || !str(raw.id) || !str(raw.question)) return null
  let state = (STATES.includes(str(raw.state)) ? raw.state : 'done') as DotTurnState
  // 应用关掉时还在答的一轮:定格成「已停止」
  if (state === 'waiting' || state === 'streaming') state = 'stopped'
  return {
    id: str(raw.id),
    question: str(raw.question),
    answer: str(raw.answer),
    steps: strings(raw.steps),
    references: Array.isArray(raw.references)
      ? raw.references.map(parseDotReference).filter((item): item is DotReference => !!item)
      : [],
    sourceTotal: str(raw.sourceTotal),
    followUps: parseFollowUps(raw.followUps),
    state,
    ...(state === 'error' ? { error: str(raw.error) || '点点这次没有答出来' } : {}),
    startedAt: time(raw.startedAt) ?? 0,
    ...(time(raw.answeredAt) !== undefined ? { answeredAt: time(raw.answeredAt) } : {}),
    ...(time(raw.finishedAt) !== undefined ? { finishedAt: time(raw.finishedAt) } : {}),
    runId: '',
    busyRetries: 0,
  }
}

/** 读回存档:认不出的条目丢掉,没有一轮能用的对话也丢掉;不抛错。 */
export function readDotHistory(raw: unknown): DotConversation[] {
  if (!isRecord(raw) || !Array.isArray(raw.conversations)) return []
  const seen = new Set<string>()
  const conversations: DotConversation[] = []
  for (const item of raw.conversations) {
    if (!isRecord(item) || !str(item.id) || seen.has(str(item.id))) continue
    const turns = (Array.isArray(item.turns) ? item.turns : []).map(readTurn).filter((turn): turn is DotTurn => !!turn)
    if (turns.length === 0) continue
    seen.add(str(item.id))
    const createdAt = time(item.createdAt) ?? turns[0].startedAt
    conversations.push({
      id: str(item.id),
      remoteId: str(item.remoteId) || null,
      title: conversationTitle(str(item.title)) || conversationTitle(turns[0].question),
      createdAt,
      updatedAt: time(item.updatedAt) ?? createdAt,
      turns,
    })
  }
  return conversations
}

export type DotHistoryPersistence = {
  load: () => Promise<{ exists: boolean; history: unknown }>
  save: (history: DotHistoryFile) => Promise<void>
}

async function call(url: string, init?: RequestInit): Promise<{ exists?: unknown; history?: unknown }> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', ...init })
  } catch {
    throw new HostRequestError('无法连接爪爪本地服务，请稍后重试')
  }
  const body = await response.json().catch(() => null) as { error?: unknown; reasonCode?: unknown; exists?: unknown; history?: unknown } | null
  if (!response.ok) {
    throw new HostRequestError(
      typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`,
      undefined,
      response.status,
      typeof body?.reasonCode === 'string' ? body.reasonCode : undefined,
    )
  }
  return body ?? {}
}

export function createHostDotHistoryPersistence(baseUrl: string): DotHistoryPersistence {
  const url = `${baseUrl.replace(/\/$/, '')}/dot/history`
  return {
    async load() {
      const body = await call(url)
      return { exists: body.exists === true, history: body.history }
    },
    async save(history) {
      await call(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(history),
      })
    },
  }
}
