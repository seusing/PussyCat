// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveOpenCliEntry } from './opencli-entry.mjs'

describe('resolveOpenCliEntry', () => {
  it('resolves the pinned package directly to dist/src/main.js', () => {
    expect(resolveOpenCliEntry()).toMatch(/[\\/]@jackwener[\\/]opencli[\\/]dist[\\/]src[\\/]main\.js$/i)
  })
})
