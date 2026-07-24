import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

export function resolveOpenCliEntry(resolve = require.resolve) {
  const entry = resolve('@jackwener/opencli')
  const realEntry = realpathSync(entry)
  if (!/[\\/]dist[\\/]src[\\/]main\.js$/i.test(realEntry)) {
    throw new Error(`Unexpected OpenCLI entry: ${realEntry}`)
  }
  return realEntry
}

// entry = …/@jackwener/opencli/dist/src/main.js → 包根 = entry/../../.. → cli-manifest.json
// 不硬编码全局 npm 路径:包在哪,manifest 就在哪
export function resolveManifestPath(entry, { existsImpl = existsSync } = {}) {
  const packageRoot = resolve(dirname(entry), '..', '..')
  const manifestPath = join(packageRoot, 'cli-manifest.json')
  if (!existsImpl(manifestPath)) {
    throw new Error(`cli-manifest.json not found at ${manifestPath} (derived from ${entry})`)
  }
  return manifestPath
}
