import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHostServer } from './host-server.mjs'
import { resolveOpenCliEntry } from './opencli-entry.mjs'
import { loadExecutionPolicy } from './policy.mjs'

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
const app = createHostServer({
  opencliEntry,
  policy,
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
