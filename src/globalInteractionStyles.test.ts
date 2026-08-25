import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/index.css', 'utf8')

describe('global button interaction styles', () => {
  it('uses the independent scale property for enabled button presses', () => {
    const rule = css.match(/button:not\(:disabled\):active\s*\{([^}]*)\}/)?.[1]
    expect(rule).toBe(' scale: .95; ')
    expect(rule).not.toContain('transform')
  })

  it('removes legacy button transform press rules', () => {
    expect(css).not.toMatch(/\.health-action-button:active[^\{]*\{[^}]*transform/)
    expect(css).not.toMatch(/\.book-demo-button:active\s*\{[^}]*transform/)
    expect(css).not.toMatch(/\.login-operation-(?:refresh|trigger):active[^\{]*\{[^}]*transform/)
  })
})
