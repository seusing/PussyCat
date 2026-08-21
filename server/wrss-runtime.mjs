import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

import { sha256File } from './vk-runtime-install.mjs'

export const WRSS_VERSION = '1.5.2'
export const WRSS_SOURCE_URL = 'https://codeload.github.com/rachelos/we-mp-rss/tar.gz/refs/tags/v1.5.2'
export const WRSS_SOURCE_FALLBACK_URL = 'https://github.com/rachelos/we-mp-rss/archive/refs/tags/v1.5.2.tar.gz'
export const WRSS_SOURCE_SHA256 = '6ad4256552ddb6fe910dcfab0bc87c962336d1b991649e35feffc004484b75c1'
export const WRSS_SIZE_LABEL = '约 356 MB（按需下载）'

const LOG_TAIL_LINES = 60
const LOOPBACK_HOST = '127.0.0.1'
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 250
const TAR_BLOCK_SIZE = 512
const MAX_EXTRACTED_ARCHIVE_BYTES = 256 * 1024 * 1024
const WRSS_BOOTSTRAP_SCRIPT = '<script src="/static/pussycat-bootstrap.js"></script>'
const WRSS_THEME_LINK = '<link rel="stylesheet" href="/static/pussycat-theme.css">'
const WRSS_UI_SCRIPT = '<script src="/static/pussycat-ui.js"></script>'
const WRSS_THEME_CSS = `:root,
html {
  color-scheme: dark;
  --color-bg-1: #0f1115 !important;
  --color-bg-2: #171a21 !important;
  --color-fill-1: rgb(23 26 33 / 72%) !important;
  --color-fill-2: rgb(38 44 56 / 72%) !important;
  --color-border: rgb(38 44 56 / 88%) !important;
  --color-text-1: #e6e9ef !important;
  --color-text-2: #9aa4b2 !important;
  --color-primary-6: #4f8cff !important;
}

html,
body,
#app {
  min-height: 100%;
  background: #0f1115 !important;
  color: #e6e9ef !important;
}

.app-container,
.app-header,
.arco-layout,
.arco-layout-content,
.arco-card,
.arco-table,
.arco-table-container,
.arco-form,
.arco-modal,
.arco-modal-content,
.arco-drawer,
.arco-drawer-content,
.arco-dropdown,
.arco-trigger-popup,
.arco-select-popup,
.arco-popover {
  border-color: rgb(38 44 56 / 82%) !important;
  background: rgb(23 26 33 / 78%) !important;
  color: #e6e9ef !important;
  backdrop-filter: blur(12px) saturate(1.08);
}

.arco-card,
.arco-modal,
.arco-drawer,
.arco-dropdown,
.arco-trigger-popup,
.arco-select-popup,
.arco-popover {
  box-shadow: 0 18px 48px rgb(0 0 0 / 32%), inset 0 1px 0 rgb(255 255 255 / 4%) !important;
}

.arco-table-th,
.arco-table-td,
.arco-menu,
.arco-list,
.arco-list-item {
  border-color: rgb(38 44 56 / 78%) !important;
  background: transparent !important;
  color: #e6e9ef !important;
}

.arco-input,
.arco-input-inner-wrapper,
.arco-textarea,
.arco-select-view,
.arco-picker,
.arco-input-tag,
.arco-radio-button,
.arco-checkbox,
.arco-btn {
  border-color: rgb(38 44 56 / 88%) !important;
  background: rgb(15 17 21 / 72%) !important;
  color: #e6e9ef !important;
}

.arco-btn-primary,
.arco-switch-checked {
  border-color: #4f8cff !important;
  background: #4f8cff !important;
  color: #fff !important;
}

.arco-input::placeholder,
.arco-textarea::placeholder,
.arco-select-view-placeholder,
.arco-empty,
.arco-typography-secondary {
  color: #9aa4b2 !important;
}

a,
.arco-link,
.arco-menu-selected {
  color: #8bb5ff !important;
}

.pussycat-hidden-link {
  display: none !important;
}

#main > .arco-layout-header {
  display: flex !important;
  align-items: center !important;
  min-height: 54px !important;
  height: auto !important;
  padding: 9px 24px !important;
  border-bottom: 1px solid rgb(38 44 56 / 72%) !important;
  background: rgb(15 17 21 / 74%) !important;
}

#main > .arco-layout-header > .arco-menu,
#main > .arco-layout-header .arco-menu-horizontal {
  flex: 0 1 auto !important;
  width: auto !important;
  min-width: 0 !important;
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  padding: 3px !important;
  border: 1px solid rgb(79 140 255 / 24%) !important;
  border-radius: 999px !important;
  background: rgb(15 17 21 / 52%) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 5%) !important;
}

#main > .arco-layout-header .arco-menu-inner {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  width: auto !important;
  overflow: visible !important;
  flex: 0 0 auto !important;
}

#main > .arco-layout-header .arco-menu-overflow-wrap {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  width: auto !important;
  min-width: max-content !important;
  height: 34px !important;
  flex: 0 0 auto !important;
}

#main > .arco-layout-header .arco-menu-overflow-sub-menu,
#main > .arco-layout-header .arco-menu-overflow-sub-menu-mirror {
  display: none !important;
}

#main > .arco-layout-header .arco-menu-item {
  height: 34px !important;
  line-height: 34px !important;
  margin: 0 !important;
  padding: 0 14px !important;
  border-radius: 999px !important;
  background: transparent !important;
  color: #b9c5d8 !important;
}

#main > .arco-layout-header .arco-menu-selected,
#main > .arco-layout-header .arco-menu-item.arco-menu-selected {
  background: rgb(79 140 255 / 18%) !important;
  color: #f6f9ff !important;
  box-shadow: inset 0 0 0 1px rgb(79 140 255 / 34%) !important;
}

#main > .arco-layout-header .arco-menu-item:hover {
  background: rgb(255 255 255 / 6%) !important;
  color: #f6f9ff !important;
}

#main > .arco-layout-header .pussycat-low-nav {
  display: none !important;
}

#main > .arco-layout-header .arco-menu-item[data-pussycat-path="/tags"],
#main > .arco-layout-header .arco-menu-item[data-pussycat-path="/message-tasks"],
#main > .arco-layout-header .arco-menu-item[data-pussycat-path="/filter-rules"],
#main > .arco-layout-header .arco-menu-item[data-pussycat-path="/task-queue"],
#main > .arco-layout-header .arco-menu-item[data-pussycat-path="/cascade/feed-status"],
#main > .arco-layout-header .arco-menu-item[data-pussycat-path="/cascade"],
#main > .arco-layout-header .arco-menu-item[data-pussycat-path="/access-keys"],
#main > .arco-layout-header .arco-menu-item[data-pussycat-path="/env-exception"],
#main > .arco-layout-header .arco-menu-item[data-pussycat-path="/configs"],
#main > .arco-layout-header .arco-menu-item[data-pussycat-path="/sys-info"] {
  display: none !important;
}

#main > .arco-layout-header .pussycat-primary-nav,
#main > .arco-layout-header .pussycat-primary-nav.arco-menu-overflow-hidden-menu-item {
  position: static !important;
  inset: auto !important;
  left: auto !important;
  top: auto !important;
  right: auto !important;
  bottom: auto !important;
  transform: none !important;
  display: inline-flex !important;
  visibility: visible !important;
}

#main > .arco-layout-header .pussycat-primary-nav[data-pussycat-path="/"] {
  order: 1;
}

#main > .arco-layout-header .pussycat-primary-nav[data-pussycat-path="/export/records"] {
  order: 2;
}

#main > .arco-layout-header .pussycat-primary-nav[data-pussycat-path="/wechat-status"] {
  order: 3;
}

.pussycat-more-wrap {
  position: relative;
  margin-left: 8px;
  flex: 0 0 auto;
}

.pussycat-more-button {
  height: 34px;
  padding: 0 12px;
  border: 1px solid rgb(79 140 255 / 24%);
  border-radius: 999px;
  background: rgb(15 17 21 / 58%);
  color: #c7d2e5;
  cursor: pointer;
}

.pussycat-more-button:hover,
.pussycat-more-wrap.is-open .pussycat-more-button {
  border-color: rgb(79 140 255 / 42%);
  background: rgb(79 140 255 / 14%);
  color: #f6f9ff;
}

.pussycat-more-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  right: auto;
  z-index: 50;
  display: none;
  min-width: 184px;
  padding: 6px;
  border: 1px solid rgb(38 44 56 / 88%);
  border-radius: 10px;
  background: rgb(23 26 33 / 92%);
  box-shadow: 0 18px 48px rgb(0 0 0 / 34%), inset 0 1px 0 rgb(255 255 255 / 4%);
  backdrop-filter: blur(14px) saturate(1.08);
}

.pussycat-more-wrap.is-open .pussycat-more-menu {
  display: grid;
  gap: 3px;
}

.pussycat-more-item {
  width: 100%;
  min-height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #b9c5d8;
  cursor: pointer;
  text-align: left;
}

.pussycat-more-item:hover,
.pussycat-more-item.is-active {
  background: rgb(79 140 255 / 14%);
  color: #f6f9ff;
}

.article-list > .arco-layout-sider,
.article-list .arco-layout-sider {
  border-right: 1px solid rgb(38 44 56 / 72%) !important;
  background: rgb(15 17 21 / 58%) !important;
}

.article-list .arco-layout-sider .arco-card,
.article-list .arco-layout-sider .arco-card-header,
.article-list .arco-layout-sider .arco-card-body {
  border-color: rgb(38 44 56 / 72%) !important;
  background: transparent !important;
}

.article-list .arco-layout-sider .arco-card-body {
  position: relative;
  padding: 12px !important;
}

.article-list .arco-layout-sider .arco-list {
  max-height: calc(100vh - 310px);
  overflow-y: auto;
  padding: 4px;
  border: 0 !important;
  background: transparent !important;
}

.article-list .arco-layout-sider .arco-list-item {
  min-height: 58px;
  margin: 4px 0;
  border: 1px solid transparent !important;
  border-radius: 8px;
  background: rgb(255 255 255 / 3%) !important;
  transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
}

.article-list .arco-layout-sider .arco-list-item:hover {
  border-color: rgb(79 140 255 / 24%) !important;
  background: rgb(79 140 255 / 10%) !important;
}

.article-list .arco-layout-sider .arco-list-item.active-mp {
  border-color: rgb(79 140 255 / 40%) !important;
  background: rgb(79 140 255 / 16%) !important;
  box-shadow: inset 3px 0 0 #4f8cff;
}
`
const WRSS_UI_JS = `(() => {
  const VERSION = 'pussycat-wrss-ui-v1'
  const previous = window.__PUSSYCAT_WRSS_UI__
  if (previous && previous.version === VERSION) return
  if (previous && typeof previous.destroy === 'function') previous.destroy()

  const state = {
    version: VERSION,
    raf: 0,
    observer: null,
    cleanup: [],
    moreWrap: null,
  }
  window.__PUSSYCAT_WRSS_UI__ = state

  const primaryNav = [
    { from: '订阅管理', label: '订阅与文章', path: '/', order: '1' },
    { from: '导出记录', label: '导出记录', path: '/export/records', order: '2' },
    { from: '授权管理', label: '授权', path: '/wechat-status', order: '3' },
  ]
  const moreNav = [
    { from: '标签管理', label: '标签管理', path: '/tags' },
    { from: '消息任务', label: '消息任务', path: '/message-tasks' },
    { from: '过滤规则', label: '过滤规则', path: '/filter-rules' },
    { from: '任务队列', label: '任务队列', path: '/task-queue' },
    { from: '公众号状态', label: '公众号状态', path: '/cascade/feed-status' },
    { from: '级联管理', label: '级联管理', path: '/cascade' },
    { from: 'Access Key', label: 'Access Key', path: '/access-keys' },
    { from: '异常统计', label: '异常统计', path: '/env-exception' },
    { from: '配置信息', label: '配置信息', path: '/configs' },
    { from: '系统信息', label: '系统信息', path: '/sys-info' },
  ]
  const headerLinks = new Set(['Views', 'Docs', 'Gitee', 'GitHub', 'ClawCloud', '云部署', '支持', '赞助'])

  function normalize(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim()
  }

  function setLastTextNode(element, label) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return normalize(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    })
    let node = null
    let last = null
    while ((node = walker.nextNode())) last = node
    if (last && normalize(last.nodeValue) !== label) last.nodeValue = label
  }

  function entryFor(item) {
    const text = normalize(item.textContent)
    const storedPath = item.dataset.pussycatPath
    return [...primaryNav, ...moreNav].find((entry) => storedPath === entry.path || text.includes(entry.from) || text === entry.label)
  }

  function closeMore() {
    if (!state.moreWrap) return
    state.moreWrap.classList.remove('is-open')
    const button = state.moreWrap.querySelector('.pussycat-more-button')
    if (button) button.setAttribute('aria-expanded', 'false')
  }

  function attrValue(value) {
    return String(value).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"')
  }

  function navigate(path) {
    closeMore()
    const selector = '.arco-menu-item[data-pussycat-path="' + attrValue(path) + '"]'
    const menuItem = document.querySelector(selector)
    if (menuItem instanceof HTMLElement) {
      menuItem.click()
      return
    }
    window.location.assign(path)
  }

  function ensureMoreMenu(menu) {
    const host = menu.parentElement
    if (!host) return
    let wrap = Array.from(host.children).find((child) => child.classList && child.classList.contains('pussycat-more-wrap'))
    if (!wrap) {
      wrap = document.createElement('div')
      wrap.className = 'pussycat-more-wrap'
      wrap.innerHTML = '<button type="button" class="pussycat-more-button" aria-haspopup="menu" aria-expanded="false">更多</button><div class="pussycat-more-menu" role="menu"></div>'
      host.appendChild(wrap)
      const button = wrap.querySelector('.pussycat-more-button')
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        const open = !wrap.classList.contains('is-open')
        wrap.classList.toggle('is-open', open)
        button.setAttribute('aria-expanded', open ? 'true' : 'false')
      })
    }
    state.moreWrap = wrap

    const panel = wrap.querySelector('.pussycat-more-menu')
    if (!panel) return
    const activePath = window.location.pathname
    const signature = activePath + '|' + moreNav.map((entry) => entry.path + ':' + entry.label).join(',')
    if (panel.dataset.pussycatSignature === signature) return
    panel.dataset.pussycatSignature = signature
    panel.replaceChildren(...moreNav.map((entry) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'pussycat-more-item' + (activePath === entry.path ? ' is-active' : '')
      button.setAttribute('role', 'menuitem')
      button.textContent = entry.label
      button.addEventListener('click', () => navigate(entry.path))
      return button
    }))
  }

  function enhanceNav() {
    const menu = document.querySelector('#main > .arco-layout-header .arco-menu-horizontal, #main > .arco-layout-header .arco-menu')
    if (!menu) return

    menu.querySelectorAll('.arco-menu-item').forEach((item) => {
      const entry = entryFor(item)
      if (!entry) return
      item.dataset.pussycatPath = entry.path
      item.classList.toggle('pussycat-primary-nav', primaryNav.some((nav) => nav.path === entry.path))
      item.classList.toggle('pussycat-low-nav', moreNav.some((nav) => nav.path === entry.path))
      if (entry.order) item.style.order = entry.order
      setLastTextNode(item, entry.label)
    })

    ensureMoreMenu(menu)
  }

  function enhanceHeaderLinks() {
    document.querySelectorAll('.app-header .header-right a').forEach((link) => {
      if (headerLinks.has(normalize(link.textContent))) link.classList.add('pussycat-hidden-link')
    })
  }

  function apply() {
    state.raf = 0
    enhanceHeaderLinks()
    enhanceNav()
  }

  function schedule() {
    if (state.raf) return
    state.raf = window.requestAnimationFrame(apply)
  }

  const onDocumentClick = (event) => {
    if (state.moreWrap && !state.moreWrap.contains(event.target)) closeMore()
  }
  const onKeyDown = (event) => {
    if (event.key === 'Escape') closeMore()
  }

  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onKeyDown)
  state.cleanup.push(() => document.removeEventListener('click', onDocumentClick))
  state.cleanup.push(() => document.removeEventListener('keydown', onKeyDown))

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule, { once: true })
  } else {
    schedule()
  }

  state.observer = new MutationObserver(schedule)
  state.observer.observe(document.documentElement, { childList: true, subtree: true })
  state.destroy = () => {
    if (state.raf) window.cancelAnimationFrame(state.raf)
    if (state.observer) state.observer.disconnect()
    state.cleanup.forEach((cleanup) => cleanup())
    if (window.__PUSSYCAT_WRSS_UI__ === state) delete window.__PUSSYCAT_WRSS_UI__
  }
})()
`

export class WrssRuntimeError extends Error {
  constructor(statusCode, reasonCode, message, detail) {
    super(message)
    this.name = 'WrssRuntimeError'
    this.statusCode = statusCode
    this.reasonCode = reasonCode
    if (detail) this.detail = detail
  }
}

export function ensureWrssStaticAssets(sourceDir) {
  const staticDir = join(sourceDir, 'static')
  const indexPath = join(staticDir, 'index.html')
  if (!isRegularFile(indexPath)) throw new WrssRuntimeError(500, 'security-patch-mismatch', 'WeRSS 页面模板不存在')
  const indexHtml = readFileSync(indexPath, 'utf8')
  const headMatches = indexHtml.match(/<\/head>/gi) ?? []
  if (headMatches.length !== 1) throw new WrssRuntimeError(500, 'security-patch-mismatch', 'WeRSS 页面模板不符合预期')
  const withoutManagedAssets = indexHtml
    .replace(/\s*<script\s+src=["']\/static\/pussycat-ui\.js["']><\/script>/gi, '')
    .replace(/\s*<script\s+src=["']\/static\/pussycat-bootstrap\.js["']><\/script>/gi, '')
    .replace(/\s*<link\s+rel=["']stylesheet["']\s+href=["']\/static\/pussycat-theme\.css["']\s*\/?>/gi, '')
  atomicText(indexPath, withoutManagedAssets.replace(/<\/head>/i, `${WRSS_THEME_LINK}\n${WRSS_BOOTSTRAP_SCRIPT}\n${WRSS_UI_SCRIPT}\n</head>`))
  atomicText(join(staticDir, 'pussycat-theme.css'), WRSS_THEME_CSS)
  atomicText(join(staticDir, 'pussycat-ui.js'), WRSS_UI_JS)
}

function tarText(buffer, start, length) {
  const field = buffer.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8')
}

function tarNumber(buffer, start, length) {
  const field = buffer.subarray(start, start + length)
  if ((field[0] & 0x80) !== 0) {
    throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包使用了不支持的数字格式')
  }
  const text = field.toString('ascii').replace(/\0.*$/, '').trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包数字字段无效')
  return Number.parseInt(text, 8)
}

function verifyTarHeader(header) {
  const expected = tarNumber(header, 148, 8)
  let actual = 0
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  if (actual !== expected) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包头校验失败')
}

function parsePax(buffer) {
  const fields = {}
  let offset = 0
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset)
    if (space < 0) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS PAX 元数据无效')
    const lengthText = buffer.subarray(offset, space).toString('ascii')
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS PAX 记录长度无效')
    const recordEnd = offset + Number.parseInt(lengthText, 10)
    if (recordEnd > buffer.length || buffer[recordEnd - 1] !== 0x0a) {
      throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS PAX 记录越界')
    }
    const record = buffer.subarray(space + 1, recordEnd - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals <= 0) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS PAX 记录无效')
    fields[record.slice(0, equals)] = record.slice(equals + 1)
    offset = recordEnd
  }
  return fields
}

function safeArchivePath(destination, archivedPath) {
  const portable = String(archivedPath).replaceAll('\\', '/').replace(/\/+$/, '')
  if (!portable || portable.startsWith('/') || portable.startsWith('//') || /^[A-Za-z]:/.test(portable)) {
    throw new WrssRuntimeError(500, 'archive-security', 'WeRSS 压缩包包含不安全路径')
  }
  const segments = portable.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new WrssRuntimeError(500, 'archive-security', 'WeRSS 压缩包包含路径穿越')
  }
  const output = resolve(destination, ...segments)
  if (!isInside(destination, output)) throw new WrssRuntimeError(500, 'archive-security', 'WeRSS 压缩包路径越界')
  return output
}

/** Extract a verified tar.gz without invoking the platform tar executable. */
export function extractTarGzipSecure(archivePath, destination) {
  let archive
  try {
    archive = gunzipSync(readFileSync(archivePath), { maxOutputLength: MAX_EXTRACTED_ARCHIVE_BYTES })
  } catch (error) {
    throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包解压失败', String(error?.message ?? error))
  }

  const entries = []
  const seen = new Set()
  let offset = 0
  let globalPax = {}
  let nextPax = {}
  let longPath = null
  let ended = false
  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE)
    if (header.every((byte) => byte === 0)) {
      ended = true
      break
    }
    verifyTarHeader(header)
    const headerSize = tarNumber(header, 124, 12)
    const type = tarText(header, 156, 1) || '0'
    const dataStart = offset + TAR_BLOCK_SIZE
    const dataEnd = dataStart + headerSize
    if (!Number.isSafeInteger(headerSize) || dataEnd > archive.length) {
      throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包内容越界')
    }
    const data = archive.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(headerSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE

    if (type === 'x' || type === 'g') {
      const parsed = parsePax(data)
      if (type === 'g') globalPax = { ...globalPax, ...parsed }
      else nextPax = parsed
      continue
    }
    if (type === 'L' || type === 'K') {
      const value = data.subarray(0, data.indexOf(0) < 0 ? data.length : data.indexOf(0)).toString('utf8')
      if (type === 'L') longPath = value
      continue
    }

    const pax = { ...globalPax, ...nextPax }
    const prefix = tarText(header, 345, 155)
    const headerPath = [prefix, tarText(header, 0, 100)].filter(Boolean).join('/')
    const archivedPath = pax.path ?? longPath ?? headerPath
    nextPax = {}
    longPath = null
    if (type === '1' || type === '2') {
      throw new WrssRuntimeError(500, 'archive-security', 'WeRSS 压缩包包含不允许的链接', `type=${type}`)
    }
    if (type !== '0' && type !== '5') {
      throw new WrssRuntimeError(500, 'archive-security', `WeRSS 压缩包包含不允许的条目类型：${type}`)
    }
    const output = safeArchivePath(destination, archivedPath)
    const key = resolve(output)
    if (seen.has(key)) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包包含重复路径')
    seen.add(key)
    const effectiveSize = pax.size === undefined ? headerSize : Number(pax.size)
    if (!Number.isSafeInteger(effectiveSize) || effectiveSize < 0 || effectiveSize !== headerSize) {
      throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包文件大小元数据不一致')
    }
    entries.push({ type, output, data })
  }
  if (!ended) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包缺少结束标记')

  // Do not write anything until every entry has passed validation.
  for (const entry of entries) {
    if (entry.type === '5') mkdirSync(entry.output, { recursive: true })
    else {
      mkdirSync(dirname(entry.output), { recursive: true })
      writeFileSync(entry.output, entry.data)
    }
  }
}

function scrub(text) {
  return String(text)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([A-Z_]*(?:SECRET|TOKEN|PASSWORD|COOKIE|KEY)[A-Z_]*)\s*=\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(secret[_-]?key|token|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:mnt|tmp|home|Users)\/)[^\s]+/g, '[path]')
}

function errorCauseDetail(error) {
  const details = []
  const seen = new Set()
  let cause = error
  for (let depth = 0; cause && depth < 4 && !seen.has(cause); depth += 1) {
    seen.add(cause)
    const code = typeof cause?.code === 'string' ? scrub(cause.code).slice(0, 80) : ''
    const message = cause?.message ? scrub(cause.message).slice(0, 240) : ''
    if (code || message) details.push(`cause[${depth}]${code ? ` code=${code}` : ''}${message ? ` message=${message}` : ''}`)
    cause = cause?.cause
  }
  return details.join(' <- ') || 'cause unavailable'
}

function isInside(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child))
  return childRelative === '' || (!isAbsolute(childRelative) && !childRelative.startsWith('..') && !childRelative.startsWith('/') && !childRelative.startsWith('\\'))
}

const WRSS_CONFIG_TEMPLATE_NAMES = Object.freeze([
  'config.example.yaml',
  'config.example.yml',
  'config-node.yaml',
  'config-node.yml',
])

function isRegularFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function copyDirectoryTree(source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const destinationPath = join(destination, entry.name)
    if (entry.isDirectory()) copyDirectoryTree(sourcePath, destinationPath)
    else if (entry.isFile()) copyFileSync(sourcePath, destinationPath)
    else throw new WrssRuntimeError(500, 'archive-security', 'WeRSS 源码目录包含不允许的文件类型')
  }
}

/**
 * Resolve the upstream configuration template without trusting a single
 * filename.  WeRSS releases have used both the example and node template
 * names; the installed copy is normalised to config.example.yaml below.
 */
export function resolveWrssConfigTemplate(sourceRoot) {
  for (const name of WRSS_CONFIG_TEMPLATE_NAMES) {
    const candidate = join(sourceRoot, name)
    if (isRegularFile(candidate)) return { path: candidate, name }
  }
  let entries = []
  try { entries = readdirSync(sourceRoot, { withFileTypes: true }) } catch { return null }
  const fallback = entries.find((entry) => (
    entry.isFile() && /^config(?:[.-](?:example|node))?\.ya?ml$/i.test(entry.name)
  ))
  return fallback
    ? { path: join(sourceRoot, fallback.name), name: fallback.name }
    : null
}

function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try { chmodSync(temporary, 0o600) } catch { /* Windows has no POSIX mode bits. */ }
  renameSync(temporary, file)
}

function atomicText(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, value, 'utf8')
  try { chmodSync(temporary, 0o600) } catch { /* Windows has no POSIX mode bits. */ }
  renameSync(temporary, file)
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function hasExpectedManifest(bundleDir) {
  if (!bundleDir) return false
  const manifestPath = join(bundleDir, 'runtime-manifest.json')
  const manifest = readJson(manifestPath)
  return !!manifest?.uv?.name && typeof manifest.uv.sha256 === 'string'
}

function defaultPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

function responseOk(response) {
  return response && (response.ok === true || (Number.isInteger(response.status) && response.status >= 200 && response.status < 400))
}

export class WrssRuntimeManager {
  #state = null
  #reasonCode = null
  #summary = null
  #version = null
  #uiUrl = null
  #log = []
  #enableFlight = null
  #child = null
  #port = null
  #secret = null
  #proxyDispatcher = null
  #proxyUrl = null

  constructor({
    home,
    bundleDir,
    env = process.env,
    fetchImpl,
    spawnImpl = spawn,
    probePythonImpl = (pythonExe) => {
      const result = spawnSync(pythonExe, ['-c', 'print("pussycat-runtime-probe")'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5_000,
      })
      return result.status === 0
    },
    now = () => new Date().toISOString(),
    sha256FileImpl = sha256File,
    runStepImpl,
    getPortImpl = defaultPort,
    readyTimeoutMs = READY_TIMEOUT_MS,
    readyPollMs = READY_POLL_MS,
    proxyAgentFactory = (url) => new ProxyAgent(url),
  } = {}) {
    this.env = env
    this.baseHome = home ?? env.OPENCLI_HOST_VK_HOME
    this.home = this.baseHome ? resolve(this.baseHome, 'wrss') : null
    this.bundleDir = bundleDir ?? env.OPENCLI_HOST_VK_BUNDLE_DIR
    this.proxyAgentFactory = proxyAgentFactory
    this.fetchImpl = fetchImpl ?? ((url, options = {}) => this.#fetchWithProxy(url, options))
    this.spawnImpl = spawnImpl
    this.probePythonImpl = probePythonImpl
    this.now = now
    this.sha256FileImpl = sha256FileImpl
    this.runStepImpl = runStepImpl
    this.getPortImpl = getPortImpl
    this.readyTimeoutMs = readyTimeoutMs
    this.readyPollMs = readyPollMs
    this.#state = this.#initialState()
  }

  async #fetchWithProxy(url, options = {}) {
    try {
      const target = new URL(url)
      if (target.hostname === LOOPBACK_HOST || target.hostname === 'localhost' || target.hostname === '::1') {
        return undiciFetch(url, options)
      }
    } catch { /* let undici produce the typed request error */ }
    const proxyUrl = this.env.HTTPS_PROXY ?? this.env.https_proxy ?? this.env.HTTP_PROXY ?? this.env.http_proxy
    if (!proxyUrl) return undiciFetch(url, options)
    if (this.#proxyUrl !== proxyUrl || !this.#proxyDispatcher) {
      this.#proxyDispatcher?.destroy?.()
      this.#proxyDispatcher = null
      this.#proxyUrl = proxyUrl
      try {
        this.#proxyDispatcher = this.proxyAgentFactory(proxyUrl)
      } catch (error) {
        this.#proxyUrl = null
        throw new WrssRuntimeError(502, 'proxy-invalid', 'WeRSS 网络代理不可用', String(error?.message ?? error))
      }
    }
    try {
      return await undiciFetch(url, { ...options, dispatcher: this.#proxyDispatcher })
    } catch (error) {
      this.#resetProxyDispatcher()
      throw error
    }
  }

  #resetProxyDispatcher() {
    this.#proxyDispatcher?.destroy?.()
    this.#proxyDispatcher = null
    this.#proxyUrl = null
  }

  #initialState() {
    if (!this.home || !hasExpectedManifest(this.bundleDir)) return 'not-available'
    const receipt = readJson(this.receiptPath)
    if (receipt?.schema === 'wrss-runtime-receipt@1'
      && receipt.version === WRSS_VERSION
      && typeof receipt.sourceDir === 'string'
      && typeof receipt.venvDir === 'string'
      && existsSync(receipt.sourceDir)
      && existsSync(receipt.venvDir)) {
      this.#version = WRSS_VERSION
      return 'installed'
    }
    return 'not-installed'
  }

  get receiptPath() { return this.home ? join(this.home, 'receipt.json') : null }
  get statePath() { return this.home ? join(this.home, 'runtime-state.json') : null }

  #pushLog(line) {
    const cleaned = scrub(line)
    if (!cleaned.trim()) return
    this.#log.push(cleaned)
    if (this.#log.length > 300) this.#log.shift()
  }

  #setFailed(error, fallback = 'WeRSS 安装或启动失败') {
    this.#state = 'failed'
    this.#reasonCode = error?.reasonCode ?? 'runtime-failed'
    this.#summary = String(error?.message ?? fallback)
    if (error?.detail) this.#pushLog(error.detail)
  }

  status() {
    const status = {
      state: this.#state ?? 'not-available',
      summary: this.#summary ?? ({
        'not-available': '公众号运行环境不可用',
        'not-installed': '公众号运行环境尚未启用',
        installing: '正在安装公众号运行环境',
        installed: '公众号运行环境已安装，等待启动',
        starting: '正在启动公众号界面',
        running: '公众号界面已就绪',
        failed: '公众号运行环境失败',
      }[this.#state] ?? '公众号运行环境不可用'),
      reason_code: this.#reasonCode,
      progress_log: this.#log.slice(-LOG_TAIL_LINES),
      version: this.#version,
      size_label: WRSS_SIZE_LABEL,
      checked_at: this.now(),
    }
    if (this.#state === 'running' && this.#uiUrl) status.ui_url = this.#uiUrl
    return status
  }

  async #runStep(step, command, argv, options = {}) {
    if (this.runStepImpl) {
      const result = await this.runStepImpl({
        step, command, argv, options,
        log: (line) => this.#pushLog(line),
      })
      return result
    }
    return new Promise((resolveStep, rejectStep) => {
      this.#pushLog(`${step}: ${String(command).split(/[\\/]/).pop()} ${argv.join(' ')}`)
      const child = this.spawnImpl(command, argv, {
        shell: false,
        windowsHide: true,
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const onData = (chunk) => {
        const text = chunk.toString('utf8')
        output += text
        for (const line of text.split(/\r?\n/)) if (line.trim()) this.#pushLog(line.trim())
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.once('error', (error) => rejectStep(new WrssRuntimeError(500, 'process-start-failed', `${step} 无法启动`, error.message)))
      child.once('close', (code) => code === 0
        ? resolveStep(output)
        : rejectStep(new WrssRuntimeError(500, 'install-failed', `${step} 失败`, scrub(output.slice(-800)))))
    })
  }

  async #downloadArchive(staging) {
    this.#pushLog('下载 WeRSS 固定版本 v1.5.2')
    const archivePath = join(staging, 'wrss.tar.gz')
    const urls = [WRSS_SOURCE_URL, WRSS_SOURCE_FALLBACK_URL]
    const failures = []
    for (let index = 0; index < urls.length; index += 1) {
      let response
      let bytes
      try {
        response = await this.fetchImpl(urls[index], { redirect: 'follow' })
        const downloadOk = Number.isInteger(response?.status)
          ? response.status >= 200 && response.status < 300
          : response?.ok === true
        if (!downloadOk) {
          await response?.body?.cancel?.()
          const detail = `attempt=${index + 1} HTTP ${response?.status ?? 'unknown'}`
          failures.push(detail)
          this.#pushLog(`WeRSS 下载线路 ${index + 1} 失败：${detail}`)
          this.#resetProxyDispatcher()
          continue
        }
        bytes = Buffer.from(await response.arrayBuffer())
      } catch (error) {
        const detail = `attempt=${index + 1} ${errorCauseDetail(error)}`
        failures.push(detail)
        this.#pushLog(`WeRSS 下载线路 ${index + 1} 传输失败：${detail}`)
        this.#resetProxyDispatcher()
        continue
      }
      writeFileSync(archivePath, bytes)
      const actual = this.sha256FileImpl(archivePath)
      if (actual !== WRSS_SOURCE_SHA256) {
        this.#resetProxyDispatcher()
        throw new WrssRuntimeError(502, 'sha-mismatch', 'WeRSS 下载包校验失败', `expected=${WRSS_SOURCE_SHA256} actual=${actual}`)
      }
      this.#pushLog(`下载包 SHA-256 校验通过（${actual.slice(0, 12)}…）`)
      return archivePath
    }
    throw new WrssRuntimeError(502, 'download-failed', '公众号组件下载失败，请检查网络后重试', failures.join(' | '))
  }

  async #install() {
    if (!this.home || !hasExpectedManifest(this.bundleDir)) {
      throw new WrssRuntimeError(503, 'bundle-missing', '公众号运行环境依赖的 uv 捆绑包不可用')
    }
    mkdirSync(this.home, { recursive: true })
    const manifestPath = join(this.bundleDir, 'runtime-manifest.json')
    const manifest = readJson(manifestPath)
    const uvPath = resolve(this.bundleDir, manifest.uv.name)
    if (!isInside(this.bundleDir, uvPath) || !existsSync(uvPath)) {
      throw new WrssRuntimeError(503, 'bundle-missing', '捆绑 uv 不存在')
    }
    const uvDigest = this.sha256FileImpl(uvPath)
    if (uvDigest !== manifest.uv.sha256) {
      throw new WrssRuntimeError(503, 'sha-mismatch', '捆绑 uv 校验失败', `expected=${manifest.uv.sha256} actual=${uvDigest}`)
    }
    this.#pushLog(`uv manifest 校验通过（${uvDigest.slice(0, 12)}…）`)

    const staging = mkdtempSync(join(tmpdir(), 'wrss-install-'))
    let versionDir = null
    let activated = false
    const extraction = join(staging, 'extract')
    mkdirSync(extraction, { recursive: true })
    try {
      const archivePath = await this.#downloadArchive(staging)
      extractTarGzipSecure(archivePath, extraction)
      this.#pushLog('WeRSS 压缩包安全解压完成')
      const roots = []
      const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === `we-mp-rss-${WRSS_VERSION}`) roots.push(path)
            visit(path)
          }
        }
      }
      visit(extraction)
      if (roots.length !== 1) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包目录结构不符合预期')
      const sourceRoot = roots[0]
      const configTemplate = resolveWrssConfigTemplate(sourceRoot)
      const requiredPaths = [
        'main.py',
        'requirements.txt',
        join('static', 'index.html'),
      ]
      if (requiredPaths.some((path) => !isRegularFile(join(sourceRoot, path))) || !configTemplate) {
        throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包缺少必需文件')
      }
      this.#pushLog(`已识别 WeRSS 配置模板：${configTemplate.name}`)
      const source = readFileSync(join(sourceRoot, 'main.py'), 'utf8')
      const hostMatches = source.match(/host="0\.0\.0\.0"/g) ?? []
      if (hostMatches.length !== 2) throw new WrssRuntimeError(500, 'security-patch-mismatch', 'WeRSS 主程序安全补丁目标不符合预期')
      let patched = source.replace(/host="0\.0\.0\.0"/g, 'host="127.0.0.1"')
      // v1.5.2 prints every environment variable during startup. Require the
      // known loop and remove it instead of silently accepting a changed shape.
      const envOccurrences = patched.match(/os\.environ\.items\(\)/g) ?? []
      if (envOccurrences.length !== 1) throw new WrssRuntimeError(500, 'security-patch-mismatch', '环境变量启动块数量不符合预期')
      const envBlock = /(^|\r?\n)([ \t]*)print\([^\r\n]*\)[ \t]*\r?\n\2[ \t]*for[ \t]+(?:key|k)[ \t]*,[ \t]*(?:value|v)[ \t]*in[ \t]+os\.environ\.items\(\)[ \t]*:[ \t]*\r?\n\2[ \t]+print\([^\r\n]*\)[ \t]*(?=\r?\n|$)/m
      if (!envBlock.test(patched)) throw new WrssRuntimeError(500, 'security-patch-mismatch', '未找到预期的环境变量打印启动块')
      patched = patched.replace(envBlock, '\n')
      if (/os\.environ\.items\(\)/.test(patched)) throw new WrssRuntimeError(500, 'security-patch-mismatch', '环境变量启动块未完全移除')
      writeFileSync(join(sourceRoot, 'main.py'), patched, 'utf8')
      ensureWrssStaticAssets(sourceRoot)
      this.#pushLog('主程序 loopback 与环境变量日志安全补丁已应用')

      versionDir = join(this.home, 'versions', `v${WRSS_VERSION}-${Date.now()}`)
      mkdirSync(versionDir, { recursive: true })
      const finalSource = join(versionDir, 'src')
      // Node 25's recursive cp creates a mojibake sibling directory for some
      // Windows Unicode destinations. Native single-file copies preserve the
      // path, so walk the already validated archive tree explicitly.
      copyDirectoryTree(sourceRoot, finalSource)
      const venvDir = join(versionDir, 'py')
      const pythonExe = join(venvDir, 'Scripts', 'python.exe')
      const copiedTemplate = join(finalSource, configTemplate.name)
      const configExample = join(finalSource, 'config.example.yaml')
      const copiedPaths = [...requiredPaths, configTemplate.name]
      const missingCopiedPaths = copiedPaths.filter((path) => !isRegularFile(join(finalSource, path)))
      if (missingCopiedPaths.length > 0) {
        throw new WrssRuntimeError(
          500,
          'archive-layout',
          'WeRSS 配置模板复制失败',
          `missing=${missingCopiedPaths.join(',')}`,
        )
      }
      this.#pushLog('WeRSS 源码目录复制与必需文件复核通过')
      if (configTemplate.name !== 'config.example.yaml') copyFileSync(copiedTemplate, configExample)
      if (!isRegularFile(configExample)) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 配置模板不存在')
      const configPath = join(this.home, 'config.yaml')
      if (!existsSync(configPath)) copyFileSync(configExample, configPath)
      const uvEnv = {
        ...this.env,
        UV_PYTHON_INSTALL_DIR: join(this.home, 'python'),
        UV_CACHE_DIR: join(staging, 'uv-cache'),
      }
      await this.#runStep('venv', uvPath, ['venv', '--python', '3.13', venvDir], { env: uvEnv })
      await this.#runStep('install', uvPath, ['pip', 'install', '--python', pythonExe, '-r', join(finalSource, 'requirements.txt')], { cwd: finalSource, env: uvEnv })
      await this.#runStep('playwright', pythonExe, ['-m', 'playwright', 'install', 'webkit'], {
        cwd: finalSource,
        env: { ...uvEnv, PLAYWRIGHT_BROWSERS_PATH: join(this.home, 'browsers') },
      })
      atomicJson(this.receiptPath, {
        schema: 'wrss-runtime-receipt@1', version: WRSS_VERSION,
        sourceDir: finalSource, venvDir, installedAt: this.now(),
      })
      activated = true
      this.#version = WRSS_VERSION
      this.#state = 'installed'
      this.#reasonCode = null
      this.#summary = null
      this.#pushLog('WeRSS 安装完成')
      return this.status()
    } finally {
      rmSync(staging, { recursive: true, force: true })
      if (!activated && versionDir) rmSync(versionDir, { recursive: true, force: true })
    }
  }

  #loadReceipt() {
    const receipt = readJson(this.receiptPath)
    if (!receipt || receipt.schema !== 'wrss-runtime-receipt@1') throw new WrssRuntimeError(500, 'receipt-missing', 'WeRSS 安装回执不存在')
    return receipt
  }

  #hasValidReceipt() {
    try {
      const receipt = this.#loadReceipt()
      return receipt.version === WRSS_VERSION
        && typeof receipt.sourceDir === 'string'
        && typeof receipt.venvDir === 'string'
        && isInside(this.home, receipt.sourceDir)
        && isInside(this.home, receipt.venvDir)
        && existsSync(receipt.sourceDir)
        && existsSync(join(receipt.venvDir, 'Scripts', 'python.exe'))
    } catch {
      return false
    }
  }

  #pythonProbePassed() {
    try {
      const receipt = this.#loadReceipt()
      const pythonExe = join(resolve(receipt.venvDir), 'Scripts', 'python.exe')
      if (!isInside(this.home, pythonExe) || !existsSync(pythonExe)) return false
      return this.probePythonImpl(pythonExe) === true
    } catch {
      return false
    }
  }

  async #terminateChild(child) {
    if (!child || this.#child !== child) return
    await new Promise((resolveClose) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolveClose() } }
      child.once('close', finish)
      try { child.kill('SIGTERM') } catch { finish() }
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
        finish()
      }, 2_000).unref?.()
    })
    if (this.#child === child) this.#child = null
  }

  async #bootstrapLogin(uiUrl, sourceDir, secret) {
    // WeRSS exposes its auth router below API_BASE=/api/v1/wx.  Calling the
    // shorter /api/v1/auth/login path returns 405 on v1.5.2 and prevents the
    // embedded UI from ever receiving its bootstrap token.
    const response = await this.fetchImpl(`${uiUrl}/api/v1/wx/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'pussycat', password: secret }).toString(),
      redirect: 'manual',
    })
    let payload = null
    try { payload = await response.json() } catch { /* handled below */ }
    const token = payload?.data?.access_token
    if (!responseOk(response) || typeof token !== 'string' || token.length < 1) {
      throw new WrssRuntimeError(502, 'auth-failed', '公众号登录初始化失败')
    }
    const bootstrapPath = join(sourceDir, 'static', 'pussycat-bootstrap.js')
    atomicText(bootstrapPath, `localStorage.setItem("token", ${JSON.stringify(token)})\n`)
  }

  async #start() {
    const receipt = this.#loadReceipt()
    const sourceDir = resolve(receipt.sourceDir)
    const pythonExe = join(resolve(receipt.venvDir), 'Scripts', 'python.exe')
    if (!isInside(this.home, sourceDir) || !isInside(this.home, pythonExe) || !existsSync(sourceDir) || !existsSync(pythonExe)) {
      throw new WrssRuntimeError(500, 'receipt-invalid', 'WeRSS 安装回执无效')
    }
    ensureWrssStaticAssets(sourceDir)
    this.#state = 'starting'
    this.#reasonCode = null
    this.#summary = null
    this.#uiUrl = null
    this.#port = await this.getPortImpl()
    const savedState = readJson(this.statePath)
    const savedSecret = savedState?.schema === 'wrss-runtime-state@1'
      && typeof savedState.secret_key === 'string'
      && /^[a-f0-9]{64}$/i.test(savedState.secret_key)
      ? savedState.secret_key
      : null
    const secret = this.#secret ?? savedSecret ?? randomBytes(32).toString('hex')
    this.#secret = secret
    atomicJson(this.statePath, { schema: 'wrss-runtime-state@1', secret_key: secret, created_at: this.now() })
    const dbPath = join(this.home, 'data', 'db.db')
    mkdirSync(dirname(dbPath), { recursive: true })
    const uiUrl = `http://${LOOPBACK_HOST}:${this.#port}`
    const childEnv = {
      ...this.env,
      PORT: String(this.#port),
      DB: `sqlite:///${dbPath.replace(/\\/g, '/')}`,
      SECRET_KEY: secret,
      USERNAME: 'pussycat',
      PASSWORD: secret,
      TOKEN_EXPIRE_MINUTES: '5256000',
      PLAYWRIGHT_BROWSERS_PATH: join(this.home, 'browsers'),
      BROWSER_TYPE: 'webkit', REDIS_SERVER_ENABLED: 'False', REDIS_URL: '',
      AUTO_RELOAD: 'False', THREADS: '1', HOST: LOOPBACK_HOST,
    }
    this.#pushLog('启动公众号界面（loopback）')
    const initFlag = existsSync(dbPath) ? 'False' : 'True'
    const child = this.spawnImpl(pythonExe, ['main.py', '-config', join(this.home, 'config.yaml'), '-job', 'True', '-init', initFlag], {
      cwd: sourceDir, env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#child = child
    const onOutput = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) this.#pushLog(line.trim())
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    let processFailureReject
    const processFailure = new Promise((_, reject) => { processFailureReject = reject })
    processFailure.catch(() => {})
    const onProcessError = (error) => {
      processFailureReject(new WrssRuntimeError(500, 'process-start-failed', 'WeRSS 进程无法启动', String(error?.message ?? error)))
    }
    child.once('error', onProcessError)
    const onExit = (code) => {
      if (this.#child !== child) return
      this.#child = null
      this.#uiUrl = null
      if (this.#state === 'starting' || this.#state === 'running') {
        this.#setFailed(new WrssRuntimeError(500, 'process-exited', `WeRSS 进程已退出（${code ?? 'unknown'}）`))
      }
    }
    child.once('exit', (code) => {
      const error = new WrssRuntimeError(500, 'process-exited', `WeRSS process exited (${code ?? 'unknown'})`)
      processFailureReject(error)
      onExit(code)
    })
    const ready = (async () => {
    const deadline = Date.now() + this.readyTimeoutMs
    while (Date.now() < deadline) {
      let response = null
      try {
        response = await this.fetchImpl(uiUrl, { redirect: 'manual' })
      } catch { /* Process may need a few seconds to boot. */ }
      if (response && responseOk(response)) {
          await response.body?.cancel?.()
          await this.#bootstrapLogin(uiUrl, sourceDir, secret)
          this.#uiUrl = uiUrl
          this.#state = 'running'
          this.#version = WRSS_VERSION
          this.#pushLog('公众号界面已就绪')
          return this.status()
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, this.readyPollMs))
    }
    throw new WrssRuntimeError(504, 'ready-timeout', '公众号界面启动超时')
    })()
    try {
      return await Promise.race([ready, processFailure])
    } catch (error) {
      await this.#terminateChild(child)
      throw error
    }
  }

  enable() {
    if (this.#enableFlight) return this.#enableFlight
    this.#enableFlight = (async () => {
      if (this.#state === 'not-available') throw new WrssRuntimeError(503, 'bundle-missing', this.status().summary)
      if (this.#state === 'running') return this.status()
      try {
        const hadExistingReceipt = this.#hasValidReceipt()
        if (this.#state === 'not-installed' || (this.#state === 'failed' && !this.#hasValidReceipt())) {
          this.#state = 'installing'
          this.#reasonCode = null
          this.#summary = null
          this.#log = []
          await this.#install()
        }
        if (this.#state === 'failed' && this.#hasValidReceipt()) {
          this.#state = 'installed'
          this.#reasonCode = null
          this.#summary = null
        }
        if (hadExistingReceipt && this.#state === 'installed' && !this.#pythonProbePassed()) {
          this.#pushLog('检测到已安装的 Python 启动器不可用，正在重建公众号运行环境')
          this.#state = 'installing'
          this.#reasonCode = null
          this.#summary = null
          await this.#install()
        }
        if (this.#state === 'installed') await this.#start()
        return this.status()
      } catch (error) {
        this.#setFailed(error)
        throw error
      } finally {
        this.#enableFlight = null
      }
    })()
    return this.#enableFlight
  }

  async close() {
    const child = this.#child
    this.#child = null
    this.#uiUrl = null
    if (child && (this.#state === 'running' || this.#state === 'starting')) this.#state = 'installed'
    if (child) {
      await new Promise((resolveClose) => {
        let done = false
        const finish = () => { if (!done) { done = true; resolveClose() } }
        child.once('close', finish)
        try { child.kill('SIGTERM') } catch { finish() }
        setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* already exited */ }
          finish()
        }, 2_000).unref?.()
      })
    }
    this.#resetProxyDispatcher()
  }
}
