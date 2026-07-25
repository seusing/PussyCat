import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHostServer } from './host-server.mjs'
import { resolveOpenCliEntry, resolveManifestPath } from './opencli-entry.mjs'
import { loadExecutionPolicy } from './policy.mjs'
import { createCatalogService } from './catalog-service.mjs'

// Node >= 20:与 @jackwener/opencli 的 engines 持平(能跑 opencli 的机器就能跑 Host)。
// 注:20 已 EOL,是"最低可运行"而非推荐;推荐当前 LTS(22/24)。
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
if (nodeMajor < 20) {
  console.error(`[opencli-host] Node >= 20 required; got ${process.versions.node}`)
  process.exit(1)
}

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
// OPENCLI_HOST_CATALOG_PATH 是测试注入点(供 readiness.test.mjs 制造协议内失败);默认行为不变。
const catalogPath = process.env.OPENCLI_HOST_CATALOG_PATH ?? resolve(projectRoot, 'public/catalog.snapshot.json')
const host = process.env.OPENCLI_HOST_ADDRESS ?? '127.0.0.1'
const port = Number.parseInt(process.env.OPENCLI_HOST_PORT ?? '43117', 10)
const allowedOrigins = (process.env.OPENCLI_HOST_ALLOWED_ORIGINS
  ?? 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

// 机器可读启动判定(供 Tauri supervisor 消费):
// 协议内失败是 Host 自知的合法响应形态,与"进程异常/非法 JSON"是不同分支——这里只负责把它说清楚。
function failReady(summary, detail) {
  process.stdout.write(`${JSON.stringify({ opencliHostReady: false, error: { summary, detail } })}\n`)
  process.exit(1)
}

try {
  const policy = loadExecutionPolicy(catalogPath)
  const opencliEntry = resolveOpenCliEntry()
  const catalogService = createCatalogService({
    opencliEntry,
    resolveManifest: () => resolveManifestPath(opencliEntry),
  })
  const app = createHostServer({
    opencliEntry,
    policy,
    catalogService,
    allowedOrigins,
    runManagerOptions: {
      cancelGraceMs: Number.parseInt(process.env.OPENCLI_HOST_CANCEL_GRACE_MS ?? '2000', 10),
      commandTimeoutMs: Number.parseInt(process.env.OPENCLI_HOST_COMMAND_TIMEOUT_MS ?? '90000', 10),
      maxConcurrentRuns: Number.parseInt(process.env.OPENCLI_HOST_MAX_CONCURRENT_RUNS ?? '1', 10),
    },
  })

  const address = await app.listen({ host, port })

  // listen 成功后第一时间打印判定行,先于任何人读日志——消费方(Tauri supervisor)只认含 opencliHostReady 的行。
  const actualPort = typeof address === 'object' && address ? address.port : port
  process.stdout.write(`${JSON.stringify({
    opencliHostReady: true,
    port: actualPort,
    pid: process.pid,
    opencliVersion: policy.opencliVersion,
    policyCommands: policy.allowedCommands.size,
  })}\n`)

  const printableAddress = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${host}:${port}`
  console.log(`[opencli-host] listening on http://${printableAddress}`)
  console.log(`[opencli-host] OpenCLI ${policy.opencliVersion}: ${opencliEntry}`)
  console.log(`[opencli-host] policy: ${policy.description} (${policy.allowedCommands.size} commands)`)

  let closing = false
  async function shutdown() {
    if (closing) return
    closing = true
    await app.close()
  }

  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })

  // 父进程存活通道(spec §5 通道 2):Tauri 保留本进程 stdin 的写端且**从不写入**;
  // 父进程一旦消亡(含崩溃/被强杀),写端关闭 → 这里收到 EOF → 自行优雅退出。
  // 这条不依赖 Job Object,正是用来覆盖 Job 分配失败的场景。
  // 开关默认关闭:不设 OPENCLI_HOST_PARENT_WATCH 时一切行为与今天完全一致(npm run dev:server 不受影响)。
  if (process.env.OPENCLI_HOST_PARENT_WATCH === '1') {
    let parentGone = false
    const exitOnParentGone = () => {
      // end 与 close 都会来;只认第一次,避免 shutdown 未完成就被第二次调用抢跑 process.exit。
      if (parentGone) return
      parentGone = true
      void shutdown().finally(() => process.exit(0))
    }
    process.stdin.resume()
    process.stdin.on('end', exitOnParentGone)
    process.stdin.on('close', exitOnParentGone)
  }
} catch (error) {
  failReady(
    error instanceof Error ? error.message : 'Host failed to start',
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  )
}
