import { createNodeBridgeHost, type EventSourceLike } from './nodeBridgeHost'
import type { DoneEvent, OutputEvent } from './types'

class FakeEventSource implements EventSourceLike {
  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  readonly url: string
  readyState = 0
  closed = false

  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, data: unknown) {
    if (type === 'open') this.readyState = 1
    const event = { data: JSON.stringify(data) } as MessageEvent
    this.listeners.get(type)?.forEach((listener) => listener(event))
  }

  close() {
    this.closed = true
    this.readyState = 2
  }
}

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

test('waits for SSE open before starting and dispatches events', async () => {
  const events: FakeEventSource[] = []
  const fetchImpl = vi.fn(async () => response(202, { runId: 'r1' }))
  const host = createNodeBridgeHost({
    baseUrl: 'http://host',
    eventSourceFactory: (url) => {
      const eventSource = new FakeEventSource(url)
      events.push(eventSource)
      return eventSource
    },
    fetchImpl,
  })
  const outputs: OutputEvent[] = []
  const dones: DoneEvent[] = []
  host.onOutput((event) => outputs.push(event))
  host.onDone((event) => dones.push(event))
  const pending = host.startCommand({ runId: 'r1', commandKey: 'x/c', argv: ['x', 'c'] })
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(events[0].url).toBe('http://host/events')
  events[0].emit('open', {})
  await pending
  expect(fetchImpl).toHaveBeenCalledWith('http://host/start', expect.objectContaining({ method: 'POST' }))
  events[0].emit('output', { runId: 'r1', seq: 0, at: 1, stream: 'stdout', text: 'ok' })
  events[0].emit('done', { runId: 'r1', at: 2, outcome: 'success' })
  expect(outputs).toHaveLength(1)
  expect(dones).toHaveLength(1)
  host.close()
  expect(events[0].closed).toBe(true)
})

test('bad event payloads are skipped and unsubscribing works', async () => {
  const eventSource = new FakeEventSource('http://host/events')
  const host = createNodeBridgeHost({ eventSourceFactory: () => eventSource, fetchImpl: async () => response(202, { runId: 'r' }) })
  const outputs: OutputEvent[] = []
  const off = host.onOutput((event) => outputs.push(event))
  const pending = host.startCommand({ runId: 'r', commandKey: 'x/c', argv: [] })
  eventSource.emit('open', {})
  await pending
  eventSource.emit('output', { invalid: true })
  eventSource.emit('output', { runId: 'r', seq: 0, at: 0, stream: 'stdout', text: 'x' })
  off()
  eventSource.emit('output', { runId: 'r', seq: 1, at: 1, stream: 'stdout', text: 'y' })
  expect(outputs).toHaveLength(1)
})

test('HTTP errors include server details and cancel posts JSON', async () => {
  const eventSource = new FakeEventSource('http://host/events')
  eventSource.readyState = 1
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(response(400, { error: 'bad request', detail: 'invalid argv' }))
    .mockResolvedValueOnce(response(204, undefined))
  const host = createNodeBridgeHost({ eventSourceFactory: () => eventSource, fetchImpl })
  await expect(host.startCommand({ runId: 'r', commandKey: 'x/c', argv: [] })).rejects.toThrow('bad request: invalid argv')
  await host.cancelCommand('r')
  expect(fetchImpl).toHaveBeenLastCalledWith('http://127.0.0.1:43117/cancel', expect.objectContaining({ body: '{"runId":"r"}' }))
})

test('a failed SSE open is closed and the next start retries with a fresh connection', async () => {
  const sources: FakeEventSource[] = []
  const host = createNodeBridgeHost({
    eventSourceFactory: (url) => {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
    fetchImpl: async () => response(202, { runId: 'r2' }),
  })
  const first = host.startCommand({ runId: 'r1', commandKey: 'x/c', argv: [] })
  sources[0].emit('error', {})
  await expect(first).rejects.toThrow('SSE connection error')
  expect(sources[0].closed).toBe(true)

  const second = host.startCommand({ runId: 'r2', commandKey: 'x/c', argv: [] })
  expect(sources).toHaveLength(2)
  sources[1].emit('open', {})
  await expect(second).resolves.toEqual({ runId: 'r2' })
})
