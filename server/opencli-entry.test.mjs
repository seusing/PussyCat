// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveOpenCliEntry } from './opencli-entry.mjs'

describe('resolveOpenCliEntry', () => {
  it('resolves the pinned package directly to dist/src/main.js', () => {
    expect(resolveOpenCliEntry()).toMatch(/[\\/]@jackwener[\\/]opencli[\\/]dist[\\/]src[\\/]main\.js$/i)
  })
})

import { resolveManifestPath } from './opencli-entry.mjs'

it('resolveManifestPath: 从 entry 反推包根 cli-manifest.json', () => {
  const entry = 'C:\\x\\node_modules\\@jackwener\\opencli\\dist\\src\\main.js'
  const seen = []
  const path = resolveManifestPath(entry, { existsImpl: (p) => { seen.push(p); return true } })
  expect(path.replace(/\\/g, '/')).toMatch(/@jackwener\/opencli\/cli-manifest\.json$/)
  expect(seen).toHaveLength(1)
})

it('resolveManifestPath: manifest 不存在 → throw', () => {
  expect(() => resolveManifestPath('C:\\x\\dist\\src\\main.js', { existsImpl: () => false }))
    .toThrow(/cli-manifest/)
})
