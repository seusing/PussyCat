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
  expect(css).toMatch(/\.arco-popover-popup-content,[\s\S]*\.arco-popconfirm-popup-content\s*\{[\s\S]*background: #171a21 !important;[\s\S]*backdrop-filter: none;/)
  expect(css).toMatch(/\.arco-trigger-popup\.arco-popover[\s\S]*\.arco-trigger-popup\.arco-popconfirm[\s\S]*animation: none !important;/)

  const dom = new JSDOM(`<style>${css}</style><div id="main"></div><div id="popup" class="arco-trigger-popup arco-popover arco-trigger-popup-enter"><div id="content" class="arco-popover-popup-content"><div>公众号</div><div id="id-row">ID: wx-example</div><div id="parent-row">说明 <span>ID: 保留在父元素中</span></div></div></div>`, {
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
    const contentStyle = dom.window.getComputedStyle(dom.window.document.getElementById('content'))
    expect(contentStyle.backgroundColor).toBe('rgb(23, 26, 33)')
    expect(dom.window.getComputedStyle(dom.window.document.getElementById('id-row')).display).toBe('none')
    expect(dom.window.getComputedStyle(dom.window.document.getElementById('parent-row')).display).not.toBe('none')
  } finally {
    dom.window.__PUSSYCAT_WRSS_UI__?.destroy()
    dom.window.close()
  }
})
