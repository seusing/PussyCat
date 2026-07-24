import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'

const require = createRequire(import.meta.url)

export function resolveOpenCliEntry(resolve = require.resolve) {
  const entry = resolve('@jackwener/opencli')
  const realEntry = realpathSync(entry)
  if (!/[\\/]dist[\\/]src[\\/]main\.js$/i.test(realEntry)) {
    throw new Error(`Unexpected OpenCLI entry: ${realEntry}`)
  }
  return realEntry
}
