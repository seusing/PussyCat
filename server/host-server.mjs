import { createServer } from 'node:http'
import { RunManager, RunManagerError } from './run-manager.mjs'
import {
  RequestPolicyError,
  validateCancelRequest,
  validateStartRequest,
} from './policy.mjs'
import { POLICY_SCHEMA_VERSION } from './policy-fingerprint.mjs'
import { checkBrowserBridgeHealth } from './browser-bridge-health.mjs'
import {
  repairBrowserBridge,
  runOpenCli as runOpenCliDefault,
  launchBrowser as launchBrowserDefault,
} from './browser-bridge-repair.mjs'
import { VkSidecarError } from './vk-sidecar.mjs'
import { VkRuntimeError } from './vk-runtime.mjs'

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

// /vk/v1/* 白名单(vk-shell-v1 契约路由表的投影)。不在表内的路径一律 404,
// 连转发都不发生——sidecar 的攻击面不因代理而扩大。
const VK_UPLOAD_MAX_BYTES = 8 * 1024 * 1024
const VK_ROUTES = [
  { method: 'GET', pattern: /^\/vk\/v1\/meta$/, target: () => '/api/meta' },
  { method: 'GET', pattern: /^\/vk\/v1\/jobs$/, target: () => '/api/jobs' },
  { method: 'GET', pattern: /^\/vk\/v1\/jobs\/([^/]+)$/, target: (m) => `/api/jobs/${m[1]}`, tap: 'view' },
  { method: 'GET', pattern: /^\/vk\/v1\/outputs\/([^/]+)$/, target: (m) => `/api/outputs/${m[1]}` },
  { method: 'GET', pattern: /^\/vk\/v1\/outputs\/([^/]+)\/([^/]+)$/, target: (m) => `/api/outputs/${m[1]}/${m[2]}` },
  { method: 'GET', pattern: /^\/vk\/v1\/diagnostic$/, target: () => '/api/diagnostic' },
  { method: 'POST', pattern: /^\/vk\/v1\/preview$/, target: () => '/api/preview', kind: 'json' },
  { method: 'POST', pattern: /^\/vk\/v1\/jobs$/, target: () => '/api/jobs', kind: 'json', tap: 'submit' },
  { method: 'POST', pattern: /^\/vk\/v1\/jobs\/([^/]+)\/(cancel|retry|refresh)$/, target: (m) => `/api/jobs/${m[1]}/${m[2]}`, kind: 'json' },
  { method: 'POST', pattern: /^\/vk\/v1\/query$/, target: () => '/api/query', kind: 'json' },
  { method: 'POST', pattern: /^\/vk\/v1\/uploads$/, target: (_m, url) => `/api/uploads${url.search}`, kind: 'raw' },
]

function matchVkRoute(method, pathname) {
  for (const route of VK_ROUTES) {
    if (route.method !== method) continue
    const match = route.pattern.exec(pathname)
    if (match) return { route, match }
  }
  return null
}

async function readRawBody(request, maxBytes) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > maxBytes) {
      throw new RequestPolicyError(413, 'Request body is too large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function safeParseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return null
  }
}

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
  browserBridgeHealth = checkBrowserBridgeHealth,
  // 修复动作三件套都可注入:测试里绝不允许真去重启 daemon 或弹出一个浏览器窗口。
  browserBridgeRepair = repairBrowserBridge,
  runOpenCli = runOpenCliDefault,
  launchBrowser = launchBrowserDefault,
  vkSidecar = null,
  vkJobShadow = null,
  vkRuntime = null,
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
        // 打出被拒的 Origin:CORS 失败在浏览器端只表现为"请求没成功",不打日志就只能靠猜——
        // 而猜 origin 的代价是"猜不准就放宽多个",直接削弱 DNS-rebinding 防线。
        // (P1 T8 正是靠这行实测捕获生产 WebView 的真实 Origin。)
        console.warn(`[opencli-host] rejected Origin: ${requestOrigin(request) ?? '(none)'} (allowed: ${[...origins].join(', ')})`)
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

      // 路由顺序说明:`/catalog` 用的是**严格相等**匹配,故本分支写在其后无碍。
      // 若后人把上面改成 startsWith,这里必须提到 `/catalog` 之前,否则永远走不到。
      if (url.pathname === '/catalog/effective' && request.method === 'GET') {
        if (!catalogService) {
          writeJson(response, 404, { error: 'Catalog refresh is not enabled' })
          return
        }
        try {
          await catalogService.refresh()
          const current = catalogService.current()
          writeJson(response, 200, {
            revision: current.revision,
            snapshot: current.snapshot,
            policy: {
              schemaVersion: POLICY_SCHEMA_VERSION,
              // 判决生成时刻,不是本次请求时刻。这个区分**不是这一行建立的** ——
              // 本端点每次请求都无条件 refresh(),真正让它成立的是 catalog-service.mjs
              // 里「revision 未变则沿用旧 generatedAt」那一步。
              generatedAt: current.generatedAt,
              decisions: current.policy.decisions,
            },
          })
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

      // BrowserBridge 健康诊断。前端**不得直连 daemon**(它拒绝非扩展 Origin 且要求 X-OpenCLI 头),
      // 由 Host 代理并做字段投影 —— 白名单与剔除理由见 browser-bridge-health.mjs。
      // 本端点永不 5xx:诊断失败本身也是结构化的诊断结果(daemon: stopped/unreachable/error)。
      if (url.pathname === '/browser-bridge/health' && request.method === 'GET') {
        writeJson(response, 200, await browserBridgeHealth({
          opencliVersion: activePolicy().opencliVersion,
        }))
        return
      }

      // 「检测并修复」。POST 而非 GET:它有副作用(可能重启 daemon、拉起浏览器)。
      // 与 /health 同样**永不 5xx** —— 修不成也是一种结构化结果,而且这个端点的返回里
      // 永远带着复检后的真实 health:动作做没做成,和桥接好没好,是两件事。
      if (url.pathname === '/browser-bridge/repair' && request.method === 'POST') {
        writeJson(response, 200, await browserBridgeRepair({
          probe: () => browserBridgeHealth({ opencliVersion: activePolicy().opencliVersion }),
          restartDaemon: () => runOpenCli(['daemon', 'restart'], { opencliEntry }),
          openBrowser: () => launchBrowser(),
        }))
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

      // video-knowledge sidecar 健康:Node 侧投影(browser-bridge 同款),永不 5xx、
      // 永不转发——sidecar 没起来时诊断本身就是答案。
      if (url.pathname === '/vk/v1/health' && request.method === 'GET') {
        writeJson(response, 200, vkSidecar ? vkSidecar.health() : {
          status: 'not-configured',
          reasonCode: 'not-configured',
          summary: 'video-knowledge sidecar 未接线',
          apiVersion: null,
          packageVersion: null,
          capabilities: [],
          checkedAt: new Date().toISOString(),
          retryable: false,
        })
        return
      }

      // 首启 runtime 安装编排(v2 阶段3):状态永 200 结构化;安装 202 单飞。
      if (url.pathname === '/vk/v1/runtime/status' && request.method === 'GET') {
        writeJson(response, 200, vkRuntime ? vkRuntime.status() : {
          state: 'not-available', version: null, reasonCode: 'bundle-missing',
          summary: 'runtime 安装编排未接线', log: [], checkedAt: new Date().toISOString(),
        })
        return
      }
      if (url.pathname === '/vk/v1/runtime/install' && request.method === 'POST') {
        if (!vkRuntime) {
          writeJson(response, 503, { error: 'runtime 安装编排未接线', reasonCode: 'bundle-missing' })
          return
        }
        // 读掉请求体:客户端要传 { rebuild: true } 时不读会把连接吊住。
        const body = await readJson(request, maxBodyBytes)
        const before = vkRuntime.status()
        if (before.state === 'not-available') {
          writeJson(response, 503, { error: before.summary, reasonCode: before.reasonCode ?? 'bundle-missing' })
          return
        }
        // 结果经 status 轮询消费;错误已在 manager 里定型。重建前先停 sidecar
        // (与 adopt 同款),否则 Windows 上正在跑的 python.exe 会锁住待删目录。
        void vkRuntime.install({
          rebuild: body?.rebuild === true,
          beforeRebuild: async () => { await vkSidecar?.stop() },
        }).catch(() => {})
        writeJson(response, 202, vkRuntime.status())
        return
      }
      if (url.pathname === '/vk/v1/runtime/detect' && request.method === 'POST') {
        await readJson(request, maxBodyBytes)
        if (!vkRuntime) throw new VkRuntimeError(503, 'bundle-missing', 'runtime 安装编排未接线')
        const detected = await vkRuntime.detect()
        writeJson(response, 200, { ...detected, checkedAt: detected.checkedAt ?? new Date().toISOString() })
        return
      }
      if (url.pathname === '/vk/v1/runtime/adopt' && request.method === 'POST') {
        const body = await readJson(request, maxBodyBytes)
        if (!vkRuntime) throw new VkRuntimeError(503, 'bundle-missing', 'runtime 安装编排未接线')
        const status = await vkRuntime.adopt(body?.pythonPath, async () => { await vkSidecar?.stop() })
        writeJson(response, 200, status)
        return
      }

      if (url.pathname.startsWith('/vk/')) {
        const matched = matchVkRoute(request.method ?? 'GET', url.pathname)
        if (!matched) {
          writeJson(response, 404, {
            error: 'vk route is not allowed',
            reasonCode: 'vk-route-not-allowed',
          })
          return
        }
        if (!vkSidecar) {
          writeJson(response, 503, {
            error: 'video-knowledge sidecar 未接线',
            reasonCode: 'not-configured',
          })
          return
        }
        const { route, match } = matched
        let clientJobId = null
        let idempotencyKey = null
        const init = { method: request.method }
        if (route.kind === 'json') {
          const body = await readJson(request, maxBodyBytes)
          if (route.tap === 'submit') {
            // client_job_id 是 shell 自己的关联键,不进 vk 的请求面。
            clientJobId = typeof body.client_job_id === 'string' ? body.client_job_id : null
            idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : null
            delete body.client_job_id
          }
          init.headers = { 'Content-Type': 'application/json' }
          init.body = JSON.stringify(body)
        } else if (route.kind === 'raw') {
          init.headers = {
            'Content-Type': request.headers['content-type'] ?? 'application/octet-stream',
          }
          init.body = await readRawBody(request, VK_UPLOAD_MAX_BYTES)
        }
        await vkSidecar.ensureStarted()
        const upstream = await vkSidecar.fetchApi(route.target(match, url), init)
        const buffer = Buffer.from(await upstream.arrayBuffer())
        if (vkJobShadow && upstream.status < 400) {
          if (route.tap === 'submit') {
            const submitted = safeParseJson(buffer)
            if (submitted?.job_id) {
              vkJobShadow.recordSubmit({
                vkJobId: submitted.job_id,
                clientJobId,
                idempotencyKey,
              })
            }
          } else if (route.tap === 'view') {
            const view = safeParseJson(buffer)
            if (view) vkJobShadow.observeView(view)
          }
        }
        response.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') ?? JSON_CONTENT_TYPE,
          'Cache-Control': 'no-store',
        })
        response.end(buffer)
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
        error instanceof RequestPolicyError
          || error instanceof RunManagerError
          || error instanceof VkSidecarError
          || error instanceof VkRuntimeError
          ? error.statusCode
          : 500
      )
      writeJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Internal server error',
        ...(error && typeof error === 'object' && 'detail' in error && error.detail
          ? { detail: error.detail }
          : {}),
        // reasonCode 是 wire 上的**稳定标识**(spec §6.1):前端业务逻辑只认它,
        // summary/detail 是给人看的自然语言,措辞随时会改。
        ...(error && typeof error === 'object' && error.reasonCode ? { reasonCode: error.reasonCode } : {}),
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
      await vkSidecar?.stop()
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
