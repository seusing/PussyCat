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
