import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Node >= 23 硬前提:catalog-service.mjs 运行时 import ../src/data/normalize.ts(type-stripping)。
// 注意不能用静态 import 引本地模块链——ESM 会在任何模块体执行前解析整张依赖图,
// 老 Node 在本断言运行前就抛 ERR_UNKNOWN_FILE_EXTENSION(静默不启)。先断言、再动态 import。
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
if (nodeMajor < 23) {
  console.error(`[opencli-host] Node >= 23 required (.ts type-stripping in catalog service); got ${process.versions.node}`)
  process.exit(1)
}

const { createHostServer } = await import('./host-server.mjs')
const { resolveOpenCliEntry, resolveManifestPath } = await import('./opencli-entry.mjs')
const { loadExecutionPolicy } = await import('./policy.mjs')
const { createCatalogService } = await import('./catalog-service.mjs')

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const catalogPath = resolve(projectRoot, 'public/catalog.snapshot.json')
const host = process.env.OPENCLI_HOST_ADDRESS ?? '127.0.0.1'
const port = Number.parseInt(process.env.OPENCLI_HOST_PORT ?? '43117', 10)
const allowedOrigins = (process.env.OPENCLI_HOST_ALLOWED_ORIGINS
  ?? 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

const policy = loadExecutionPolicy(catalogPath)
const opencliEntry = resolveOpenCliEntry()
const catalogService = createCatalogService({
  opencliEntry,
  manifestPath: resolveManifestPath(opencliEntry),
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
