// @vitest-environment node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { wrssPinBundle, wrssPinPython, wrssPinSuccess, wrssPinWechatStatus } from '../test-fixtures/wrss-pin.mjs'
import { ensureWrssStaticAssets } from './wrss-runtime.mjs'

let sourceDir

afterEach(() => {
  if (sourceDir) rmSync(sourceDir, { recursive: true, force: true })
  sourceDir = undefined
})

it('keeps trigger shells transparent while styling popup content with the Arco dark theme', async () => {
  sourceDir = await mkdtemp(join(tmpdir(), 'wrss-popup-theme-'))
  mkdirSync(join(sourceDir, 'static', 'assets'), { recursive: true })
  mkdirSync(join(sourceDir, 'driver'), { recursive: true })
  writeFileSync(join(sourceDir, 'static', 'index.html'), '<html><head></head><body><div id="main"></div></body></html>')
  writeFileSync(join(sourceDir, 'static', 'assets', 'index.a75a6e55.js'), wrssPinBundle)
  writeFileSync(join(sourceDir, 'static', 'assets', 'WechatStatus.62cf3d3b.js'), wrssPinWechatStatus)
  writeFileSync(join(sourceDir, 'driver', 'wx.py'), wrssPinPython)
  writeFileSync(join(sourceDir, 'driver', 'success.py'), wrssPinSuccess)

  ensureWrssStaticAssets(sourceDir)

  const css = readFileSync(join(sourceDir, 'static', 'pussycat-theme.css'), 'utf8')
  const script = readFileSync(join(sourceDir, 'static', 'pussycat-ui.js'), 'utf8')
  expect(css).toMatch(/\.arco-popover-popup-content,[\s\S]*\.arco-popconfirm-popup-content,[\s\S]*\.arco-select-dropdown,[\s\S]*\.arco-dropdown\s*\{[\s\S]*background: rgb\(23 26 33 \/ 78%\) !important;/)

  const dom = new JSDOM(`<style>${css}</style><div id="main"></div><div id="popup" class="arco-trigger-popup arco-popover"><div class="arco-popover-popup-content">内容</div></div>`, {
    url: 'http://127.0.0.1:43202/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  })
  try {
    dom.window.eval(script)
    await new Promise((resolve) => dom.window.requestAnimationFrame(resolve))
    expect(dom.window.document.body.getAttribute('arco-theme')).toBe('dark')
    const popupStyle = dom.window.getComputedStyle(dom.window.document.getElementById('popup'))
    expect(popupStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(popupStyle.boxShadow).toBe('none')
  } finally {
    dom.window.__PUSSYCAT_WRSS_UI__?.destroy()
    dom.window.close()
  }
})
