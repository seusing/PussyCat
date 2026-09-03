import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const indexCss = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

test('scrollable surfaces use transparent-by-default fading scrollbars', () => {
  expect(indexCss).toMatch(/\.scroll-fade,[\s\S]*scrollbar-color:\s*transparent transparent;/)
  expect(indexCss).toMatch(/\.scroll-fade:is\(:hover, :focus-visible, :focus-within, :active\)[\s\S]*scrollbar-color:\s*color-mix\(/)
  expect(indexCss).toMatch(/::-webkit-scrollbar-thumb[\s\S]*background:\s*transparent;/)
})

test('shared scrollbar selectors cover app, task, output, log, and overflow utility regions', () => {
  for (const selector of [
    '.app-content',
    '.vk-task-table-viewport',
    '.vk-task-detail-body',
    '.vk-output-viewer-content',
    '.wrss-log',
    '[class~="overflow-auto"]',
  ]) {
    expect(indexCss).toContain(selector)
  }
  expect(indexCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
})
