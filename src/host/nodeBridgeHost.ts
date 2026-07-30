import type { DoneEvent, HostBridge, OutputEvent, RunRequest } from './types'
import { HostRequestError } from './errors'

export interface EventSourceLike {
  readonly readyState?: number
  addEventListener?: (type: string, listener: (event: Event) => void) => void
  removeEventListener?: (type: string, listener: (event: Event) => void) => void
  onopen?: ((event: Event) => void) | null
  onerror?: ((event: Event) => void) | null
  onoutput?: ((event: Event) => void) | null
  ondone?: ((event: Event) => void) | null
  close?: () => void
}

export type NodeBridgeHostOptions = {
  baseUrl?: string
  eventSourceFactory?: (url: string) => EventSourceLike
  fetchImpl?: typeof fetch
  connectTimeoutMs?: number
}

type HostWithClose = HostBridge & { close: () => void }

export const DEFAULT_BASE_URL = 'http://127.0.0.1:43117'
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

function eventMessage(event: Event): string | undefined {
  const data = (event as Event & { data?: unknown }).data
  return typeof data === 'string' ? data : undefined
}

function responseError(status: number, payload: unknown): HostRequestError {
  let summary = ''
  let detail = ''
  let reasonCode: string | undefined
  if (payload && typeof payload === 'object') {
    const body = payload as { error?: unknown; detail?: unknown; message?: unknown; reasonCode?: unknown }
    if (typeof body.error === 'string') summary = body.error
    else if (body.error && typeof body.error === 'object') {
      const nested = body.error as { summary?: unknown; detail?: unknown; message?: unknown }
      if (typeof nested.summary === 'string') summary = nested.summary
      else if (typeof nested.message === 'string') summary = nested.message
      if (typeof nested.detail === 'string') detail = nested.detail
    }
    else if (typeof body.message === 'string') summary = body.message
    if (typeof body.detail === 'string') detail = body.detail
    // Task 8:透传服务端的稳定 reasonCode(host-server.mjs 的 {error,detail,reasonCode} 扁平体)——
    // 前端 409/428 分派只认这个字段,不认 summary 自然语言文案。
    if (typeof body.reasonCode === 'string') reasonCode = body.reasonCode
  }
  // detail 兜底回填 HTTP 状态码:服务端给了 summary 时状态码原本在 UI/复制载荷里彻底不可见,
  // 500/代理错误会失去排障抓手(评审观察 1)
  return new HostRequestError(summary || `HTTP ${status}`, detail || (summary ? `HTTP ${status}` : undefined), status, reasonCode)
}

function isOutputEvent(value: unknown): value is OutputEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<OutputEvent>
  return typeof event.runId === 'string' && typeof event.seq === 'number' && typeof event.at === 'number' &&
    (event.stream === 'stdout' || event.stream === 'stderr') && typeof event.text === 'string'
}

function isDoneEvent(value: unknown): value is DoneEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<DoneEvent>
  return typeof event.runId === 'string' && typeof event.at === 'number' &&
    (event.outcome === 'success' || event.outcome === 'error' || event.outcome === 'cancelled')
}

async function parseResponse(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

export function createNodeBridgeHost(options: NodeBridgeHostOptions = {}): HostWithClose {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const eventSourceFactory: (url: string) => EventSourceLike = options.eventSourceFactory ?? ((url: string) => new EventSource(url))
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const outputCbs = new Set<(event: OutputEvent) => void>()
  const doneCbs = new Set<(event: DoneEvent) => void>()

  let source: EventSourceLike | undefined
  let opening: Promise<void> | undefined

  const handleOutput = (event: Event) => {
    const data = eventMessage(event)
    if (!data) return
    try {
      const parsed = JSON.parse(data) as OutputEvent
      if (!isOutputEvent(parsed)) return
      outputCbs.forEach((cb) => cb(parsed))
    } catch {
      // Ignore malformed server events.
    }
  }
  const handleDone = (event: Event) => {
    const data = eventMessage(event)
    if (!data) return
    try {
      const parsed = JSON.parse(data) as DoneEvent
      if (!isDoneEvent(parsed)) return
      doneCbs.forEach((cb) => cb(parsed))
    } catch {
      // Ignore malformed server events.
    }
  }

  const close = () => {
    source?.close?.()
    source = undefined
    opening = undefined
  }

  const ensureOpen = (): Promise<void> => {
    if (source?.readyState === 1) return Promise.resolve()
    if (opening) return opening

    const current = eventSourceFactory(`${baseUrl}/events`)
    source = current
    if (current.addEventListener) {
      current.addEventListener('output', handleOutput)
      current.addEventListener('done', handleDone)
    } else {
      current.onoutput = handleOutput
      current.ondone = handleDone
    }
    opening = new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          current.close?.()
          if (source === current) source = undefined
          opening = undefined
          reject(error)
        } else {
          resolve()
        }
      }
      const onOpen = () => finish()
      const onError = () => finish(new Error('SSE connection error'))
      if (current.addEventListener) {
        current.addEventListener('open', onOpen)
        current.addEventListener('error', onError)
      } else {
        current.onopen = onOpen
        current.onerror = onError
      }
      timer = setTimeout(() => finish(new Error(`SSE open timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs)
      if (current.readyState === 1) finish()
    })
    return opening
  }

  const postJson = async (path: string, body: unknown): Promise<Response> => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw responseError(response.status, await parseResponse(response))
    }
    return response
  }

  return {
    async startCommand(req: RunRequest) {
      await ensureOpen()
      const response = await postJson('/start', req)
      const payload = await parseResponse(response)
      const runId = payload && typeof payload === 'object' ? (payload as { runId?: unknown }).runId : undefined
      if (runId !== req.runId) {
        throw new Error(`Invalid start response runId: expected ${req.runId}`)
      }
      return { runId: req.runId }
    },

    async cancelCommand(runId: string) {
      await postJson('/cancel', { runId })
    },

    onOutput(cb) {
      outputCbs.add(cb)
      return () => outputCbs.delete(cb)
    },

    onDone(cb) {
      doneCbs.add(cb)
      return () => doneCbs.delete(cb)
    },

    close,
  }
}
