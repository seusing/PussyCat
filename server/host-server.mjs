import { createServer } from 'node:http'
import { RunManager, RunManagerError } from './run-manager.mjs'
import {
  RequestPolicyError,
  validateCancelRequest,
  validateStartRequest,
} from './policy.mjs'

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

class SseBroker {
  constructor({ bufferSize = 2048, heartbeatMs = 15_000 } = {}) {
    this.bufferSize = bufferSize
    this.clients = new Set()
    this.events = []
    this.nextId = 1
    this.heartbeat = setInterval(() => {
      for (const response of this.clients) response.write(': heartbeat\n\n')
    }, heartbeatMs)
    this.heartbeat.unref?.()
  }

  publish(type, value) {
    const event = { id: this.nextId, type, value }
    this.nextId += 1
    this.events.push(event)
    if (this.events.length > this.bufferSize) this.events.shift()
    for (const response of this.clients) this.#write(response, event)
  }

  subscribe(response, lastEventId) {
    const lastId = Number.parseInt(lastEventId ?? '0', 10)
    if (Number.isFinite(lastId) && lastId > 0) {
      const oldest = this.events[0]
      // 缺口检测两支(评审 I-3:原版只查驱逐,漏了生产里更常见的重启):
      //  ① evicted —— 续传位置早于缓冲最老事件,中间那段已被 shift 驱逐
      //  ② restart —— 客户端游标 >= nextId,即服务端重启后 id 归 1(缓冲空亦落此支);此时丢失区间未知
      const restarted = lastId >= this.nextId
      const evicted = !restarted && !!oldest && oldest.id > lastId + 1
      if (restarted || evicted) {
        const gap = restarted
          ? { reason: 'restart', from: 1, to: null }
          : { reason: 'evicted', from: lastId + 1, to: oldest.id - 1 }
        response.write(`event: gap\ndata: ${JSON.stringify(gap)}\n\n`)   // 无 id 行:不打乱续传游标
        console.warn(`[opencli-host] SSE replay gap (${gap.reason}): client resumed at ${lastId}, lost ${gap.from}-${gap.to ?? '?'} (bufferSize=${this.bufferSize})`)
      }
      for (const event of this.events) {
        // restart 时客户端游标属于旧进程的 id 空间,与新进程不可比:必须无条件补发当前缓冲,
        // 否则 event.id <= nextId-1 <= lastId 会把新进程的全部事件过滤光(评审 P1)
        if (restarted || event.id > lastId) this.#write(response, event)
      }
    }
    this.clients.add(response)
    return () => this.clients.delete(response)
  }

  close() {
    clearInterval(this.heartbeat)
    for (const response of this.clients) response.end()
    this.clients.clear()
  }

  #write(response, event) {
    response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.value)}\n\n`)
  }
}

function writeJson(response, statusCode, value, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  response.end(JSON.stringify(value))
}

function requestOrigin(request) {
  const origin = request.headers.origin
  return typeof origin === 'string' ? origin : undefined
}

function applyCors(request, response, allowedOrigins) {
  const origin = requestOrigin(request)
  if (!origin || !allowedOrigins.has(origin)) return false
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  return true
}

async function readJson(request, maxBodyBytes) {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new RequestPolicyError(415, 'Content-Type must be application/json')
  }

  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > maxBodyBytes) {
      throw new RequestPolicyError(413, 'Request body is too large')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestPolicyError(400, 'Request body is not valid JSON')
  }
}

export function createHostServer({
  opencliEntry,
  policy,
  catalogService,
  allowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'],
  maxBodyBytes = 64 * 1024,
  runManagerOptions = {},
  sseOptions = {},
} = {}) {
  if (!policy) throw new Error('policy is required')
  const activePolicy = () => catalogService?.current()?.policy ?? policy
  const origins = new Set(allowedOrigins)
  const broker = new SseBroker(sseOptions)
  const runManager = new RunManager({
    opencliEntry,
    emitEvent: (type, event) => broker.publish(type, event),
    ...runManagerOptions,
  })

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')

      if (url.pathname === '/health' && request.method === 'GET') {
        const origin = requestOrigin(request)
        if (origin && !applyCors(request, response, origins)) {
          writeJson(response, 403, { error: 'Origin is not allowed' })
          return
        }
        writeJson(response, 200, {
          status: 'ok',
          opencliVersion: activePolicy().opencliVersion,
          executionPolicy: activePolicy().description,
          activeRuns: runManager.active.size,
        })
        return
      }

      if (request.method === 'OPTIONS') {
        if (!applyCors(request, response, origins)) {
          writeJson(response, 403, { error: 'Origin is not allowed' })
          return
        }
        response.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
        })
        response.end()
        return
      }

      if (!applyCors(request, response, origins)) {
        writeJson(response, 403, { error: 'Origin is required and must be allowed' })
        return
      }

      if (url.pathname === '/catalog' && request.method === 'GET') {
        if (!catalogService) {
          writeJson(response, 404, { error: 'Catalog refresh is not enabled' })
          return
        }
        try {
          const snapshot = await catalogService.refresh()
          writeJson(response, 200, snapshot)      // 只在原子替换完成后返回:目录与生效 policy 恒一致
        } catch (error) {
          const statusCode = (error && typeof error === 'object' && Number.isInteger(error.statusCode))
            ? error.statusCode
            : 500
          writeJson(response, statusCode, {
            error: {
              summary: error instanceof Error ? error.message : 'Catalog refresh failed',
              ...(error && typeof error === 'object' && error.detail ? { detail: error.detail } : {}),
            },
          })
        }
        return
      }

      if (url.pathname === '/events' && request.method === 'GET') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        response.flushHeaders()
        const unsubscribe = broker.subscribe(response, request.headers['last-event-id'])
        request.once('close', unsubscribe)
        return
      }

      if (url.pathname === '/start' && request.method === 'POST') {
        const body = await readJson(request, maxBodyBytes)
        const command = validateStartRequest(body, activePolicy())
        const result = runManager.start(command)
        writeJson(response, 202, result)
        return
      }

      if (url.pathname === '/cancel' && request.method === 'POST') {
        const body = await readJson(request, maxBodyBytes)
        const { runId } = validateCancelRequest(body)
        runManager.cancel(runId)
        response.writeHead(204)
        response.end()
        return
      }

      writeJson(response, 404, { error: 'Not found' })
    } catch (error) {
      const statusCode = (
        error instanceof RequestPolicyError || error instanceof RunManagerError
          ? error.statusCode
          : 500
      )
      writeJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Internal server error',
        ...(error && typeof error === 'object' && 'detail' in error && error.detail
          ? { detail: error.detail }
          : {}),
      })
    }
  })

  return {
    server,
    runManager,
    listen({ host = '127.0.0.1', port = 43117 } = {}) {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error)
        server.once('error', onError)
        server.listen(port, host, () => {
          server.off('error', onError)
          resolve(server.address())
        })
      })
    },
    async close() {
      catalogService?.close()
      runManager.close()
      broker.close()
      if (!server.listening) return
      const closed = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      // Node/undici may retain idle keep-alive sockets after a test or dev-browser
      // disconnect. The Host is shutting down, so no connection should outlive it.
      server.closeAllConnections?.()
      await closed
    },
  }
}
