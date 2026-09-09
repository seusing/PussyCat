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
import { ensureWrssSourcePatches } from './wrss-patches.mjs'

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
const WRSS_AUTH_SCRIPT = '<script src="/static/pussycat-auth.js"></script>'
const WRSS_UI_SCRIPT = '<script src="/static/pussycat-ui.js"></script>'
const WRSS_THEME_CSS = `:root,
html,
body {
  color-scheme: dark;
  --color-bg-1: #0f1115 !important;
  --color-bg-2: #171a21 !important;
  --color-fill-1: rgb(23 26 33 / 72%) !important;
  --color-fill-2: rgb(38 44 56 / 72%) !important;
  --color-fill-3: #303745 !important;
  --color-border: rgb(38 44 56 / 88%) !important;
  --color-text-1: #e6e9ef !important;
  --color-text-2: #9aa4b2 !important;
  --color-text-3: #8995a7 !important;
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
.arco-select-dropdown,
.arco-dropdown {
  border-color: rgb(38 44 56 / 82%) !important;
  background: rgb(23 26 33 / 78%) !important;
  color: #e6e9ef !important;
  backdrop-filter: blur(12px) saturate(1.08);
}

.arco-popover-popup-content,
.arco-popconfirm-popup-content {
  border-color: rgb(38 44 56 / 82%) !important;
  background: #171a21 !important;
  color: #e6e9ef !important;
  backdrop-filter: none;
}

.arco-card,
.arco-modal,
.arco-drawer,
.arco-popover-popup-content,
.arco-popconfirm-popup-content,
.arco-select-dropdown,
.arco-dropdown {
  box-shadow: 0 18px 48px rgb(0 0 0 / 32%), inset 0 1px 0 rgb(255 255 255 / 4%) !important;
}

.arco-trigger-popup {
  border: 0;
  background: transparent !important;
  box-shadow: none !important;
  backdrop-filter: none;
}

.arco-trigger-popup.arco-popover[class*="-enter"],
.arco-trigger-popup.arco-popover[class*="-leave"],
.arco-trigger-popup.arco-popconfirm[class*="-enter"],
.arco-trigger-popup.arco-popconfirm[class*="-leave"] {
  animation: none !important;
  transition: none !important;
  opacity: 1 !important;
}

.pussycat-popup-id-row {
  display: none !important;
}

.app-header {
  display: none !important;
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

.pussycat-wechat-authorized-hidden {
  display: none !important;
}

#main > .arco-layout-header {
  display: flex !important;
  align-items: center !important;
  min-height: 58px !important;
  height: auto !important;
  gap: 14px !important;
  padding: 10px 20px !important;
  border-bottom: 1px solid rgb(38 44 56 / 72%) !important;
  background: rgb(15 17 21 / 92%) !important;
}

#main > .arco-layout-header > .arco-menu,
#main > .arco-layout-header .arco-menu-horizontal {
  flex: 1 1 auto !important;
  width: auto !important;
  min-width: 0 !important;
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}

#main > .arco-layout-header .arco-menu-inner {
  display: flex !important;
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
  padding: 0 10px !important;
  border-radius: 999px !important;
  background: transparent !important;
  color: #b9c5d8 !important;
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
  pointer-events: auto !important;
}

#main > .arco-layout-header [aria-current="page"] {
  background: rgb(79 140 255 / 18%) !important;
  color: #f6f9ff !important;
  box-shadow: inset 0 0 0 1px rgb(79 140 255 / 34%) !important;
}

.pussycat-brand {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 9px;
  color: #f6f9ff;
  font-size: 16px;
  font-weight: 650;
  white-space: nowrap;
}
.pussycat-brand { display:none !important; }

.pussycat-brand-mark {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #4f8cff;
  box-shadow: 0 0 0 4px rgb(79 140 255 / 14%);
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
  margin-left: auto;
  flex: 0 0 auto;
}

.pussycat-more-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 13px;
  border: 1px solid rgb(79 140 255 / 32%);
  border-radius: 8px;
  background: rgb(79 140 255 / 10%);
  color: #c7d2e5;
  cursor: pointer;
}

.pussycat-more-button > span:first-child {
  display: inline-grid;
  gap: 3px;
  width: 16px;
}

.pussycat-more-button > span:first-child > span {
  display: block;
  height: 2px;
  border-radius: 2px;
  background: currentColor;
}

.pussycat-more-button:hover,
.pussycat-more-wrap.is-open .pussycat-more-button {
  border-color: rgb(79 140 255 / 42%);
  background: rgb(79 140 255 / 14%);
  color: #f6f9ff;
}

.pussycat-more-menu {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 60;
  display: grid;
  align-content: start;
  gap: 4px;
  width: min(320px, 88vw);
  padding: 18px 14px;
  overflow-y: auto;
  transform: translateX(-105%);
  transition: transform 180ms ease;
  border: 1px solid rgb(38 44 56 / 88%);
  border-radius: 0 12px 12px 0;
  background: rgb(23 26 33 / 92%);
  box-shadow: 0 18px 48px rgb(0 0 0 / 34%), inset 0 1px 0 rgb(255 255 255 / 4%);
  backdrop-filter: blur(14px) saturate(1.08);
}

.pussycat-drawer-close {
  justify-self: end;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid rgb(38 44 56 / 88%);
  border-radius: 7px;
  background: transparent;
  color: #b9c5d8;
  cursor: pointer;
}

.pussycat-drawer-items { display: grid; gap: 4px; }
.pussycat-menu-group { margin: 14px 10px 4px; color: #778399; font-size: 12px; font-weight: 600; }

.pussycat-article-actions { padding-bottom: 14px; margin-bottom: 10px; border-bottom: 1px solid rgb(38 44 56 / 88%); }
.pussycat-article-actions[hidden] { display: none; }
.pussycat-article-actions h2 { margin: 8px 10px 12px; font-size: 14px; color: #9aa4b2; }
.pussycat-article-actions .arco-page-header-extra { margin: 0; }
.pussycat-article-actions .arco-space { display: grid !important; grid-template-columns: auto 1fr; width: 100%; gap: 8px !important; }
.pussycat-article-actions .arco-space-item { margin: 0 !important; grid-column: 1 / -1; }
.pussycat-article-actions .arco-space-item:first-child { grid-column: 1; align-self: center; padding-left: 10px; }
.pussycat-article-actions .arco-space-item:nth-child(2) { grid-column: 2; }
.pussycat-article-actions .arco-btn { width: 100%; justify-content: flex-start; }
.pussycat-article-actions .arco-btn:disabled { opacity: .4; }
.pussycat-source-search { order: -1; min-width: 240px; margin-right: 12px; }
.pussycat-frequent-group { display: inline-flex; align-items: center; gap: 6px; margin: 4px 8px; color: #9aa4b2; font-size: 13px; }
.pussycat-frequent-group button { border: 0; background: transparent; color: #c7d2e5; cursor: pointer; padding: 3px 6px; }
.pussycat-empty-state { display: grid; min-height: 76px; place-items: center; margin: 12px 4px; border: 1px dashed rgb(38 44 56 / 88%); border-radius: 8px; color: #9aa4b2; font-size: 13px; text-align: center; }
.pussycat-count-hidden { display: none !important; }
.article-list .arco-page-header-extra { position: relative; z-index: 2; }
.article-list .arco-dropdown-menu, .article-list .arco-select-popup, .article-list .arco-trigger-popup { z-index: 1200 !important; }
.pussycat-more-menu ~ .arco-trigger-popup { z-index: 1000; }

.pussycat-more-menu.is-open {
  transform: translateX(0);
}

.pussycat-menu-scrim {
  position: fixed;
  inset: 0;
  z-index: 55;
  display: none;
  border: 0;
  background: rgb(0 0 0 / 42%);
}

.pussycat-menu-scrim.is-visible { display: block; }

.pussycat-more-item {
  width: 100%;
  min-height: 40px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #b9c5d8;
  cursor: pointer;
  text-align: left;
}

.pussycat-more-item:hover,
.pussycat-more-item[aria-current="page"] {
  background: rgb(79 140 255 / 14%);
  color: #f6f9ff;
}
.pussycat-menu-alert { margin: 6px 14px; color: #ff8f8f; font-size: 13px; }

.article-list { flex-direction: column !important; }
.article-list > .arco-layout-sider {
  width: 100% !important;
  max-width: 100% !important;
  min-width: 0 !important;
  flex: none !important;
  border: 0 !important;
  border-bottom: 1px solid rgb(38 44 56 / 72%) !important;
  background: #0f1115 !important;
}
.article-list > .arco-layout-content { min-width: 0; padding: 16px 20px !important; }
.article-list .arco-layout-sider .arco-card {
  display: grid;
  grid-template-columns: auto minmax(180px, 1fr) auto auto;
  align-items: center;
  gap: 12px 16px;
  padding: 16px 20px;
  border: 0 !important;
  border-radius: 0;
  background: transparent !important;
  box-shadow: none !important;
  backdrop-filter: none;
}
.article-list .arco-layout-sider .arco-card-header,
.article-list .arco-layout-sider .arco-card-body,
.article-list .arco-layout-sider .arco-card-body > div {
  display: contents !important;
  background: transparent !important;
}
.article-list .arco-layout-sider .arco-card-header-title { grid-column: 1; grid-row: 1; color: #e6e9ef; font-size: 16px; }
.article-list .arco-layout-sider .arco-card-header-extra { grid-column: 4; grid-row: 1; justify-self: end; }
.article-list .arco-layout-sider .arco-card-body > div > div:first-child { grid-column: 2; grid-row: 1; margin: 0 !important; }
.article-list .arco-layout-sider .arco-card-body > div > div:nth-child(2) { grid-column: 3; grid-row: 1; margin: 0 !important; padding: 0 !important; }
.article-list .arco-layout-sider .arco-pagination { grid-column: 4; grid-row: 2; justify-self: end; margin: 0 !important; }
.article-list .arco-layout-sider .arco-list-wrapper { grid-column: 1 / -2; grid-row: 2; min-width: 0; }
.article-list .arco-layout-sider .arco-list {
  grid-column: 1 / -1;
  min-width: 0;
  overflow-x: auto;
  border: 0 !important;
}
.article-list .arco-layout-sider .arco-list-content { display: flex; gap: 8px; min-width: max-content; }
.article-list .arco-layout-sider .arco-list-item {
  flex: 0 0 auto;
  width: auto;
  min-height: 42px;
  margin: 0;
  padding: 8px 12px !important;
  white-space: nowrap;
  border: 1px solid transparent !important;
  border-radius: 8px;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.article-list .arco-layout-sider .arco-list-item img { width: 24px !important; height: 24px; margin-right: 8px !important; object-fit: cover; border-radius: 50%; }
.article-list .arco-layout-sider .arco-list-item .arco-typography { color: #b9c5d8; line-height: 24px !important; }
.article-list .arco-layout-sider .arco-list-item:hover {
  border-color: rgb(79 140 255 / 24%) !important;
  background: rgb(79 140 255 / 10%) !important;
}

.article-list .arco-layout-sider .arco-list-item[aria-current="page"] {
  border-color: rgb(79 140 255 / 40%) !important;
  background: rgb(79 140 255 / 16%) !important;
  box-shadow: none;
}
.article-list .arco-page-header { padding: 0 0 14px !important; }
.article-list .arco-page-header-title,
.article-list .arco-pagination { color: #e6e9ef; }
.article-list .arco-pagination-total,
.article-list .arco-pagination-simple-pager,
.article-list .arco-pagination-jumper-total-page { color: #9aa4b2; }
.article-list .arco-input-wrapper,
.article-list .arco-radio-group-button { border-color: rgb(38 44 56 / 88%); background: #171a21 !important; }
.article-list .arco-input-wrapper .arco-input { background: transparent !important; }
.article-list .arco-radio-checked { background: rgb(79 140 255 / 18%) !important; color: #e6e9ef !important; }
.article-list .arco-page-header-subtitle,
.article-list .arco-page-header-divider { display: none; }
.article-list .arco-empty {
  min-height: 156px; margin: 16px 0; padding: 28px 20px;
  border: 1px dashed rgb(79 140 255 / 28%); border-radius: 12px;
  background: rgb(23 26 33 / 72%); color: #9aa4b2 !important;
}
.article-list .arco-empty .arco-empty-image { margin-bottom: 10px; opacity: .82; }
.article-list .arco-empty .arco-empty-description { color: #9aa4b2 !important; }
@media (max-width: 720px) {
  .article-list .arco-layout-sider .arco-card { grid-template-columns: 1fr auto; }
  .article-list .arco-layout-sider .arco-card-header-extra { grid-column: 2; }
  .article-list .arco-layout-sider .arco-card-body > div > div:first-child { grid-column: 1; grid-row: 2; }
  .article-list .arco-layout-sider .arco-card-body > div > div:nth-child(2) { grid-column: 2; grid-row: 2; }
  .article-list .arco-layout-sider .arco-list-wrapper { grid-column: 1 / -1; grid-row: 3; }
  .article-list .arco-layout-sider .arco-pagination { grid-column: 1 / -1; grid-row: 4; }
}
#pussycat-settings-panel {
  flex: 0 0 auto;
  margin: 20px 24px 0;
  color: #e6e9ef;
}
.pussycat-settings-heading { margin: 0 0 12px; font-size: 20px; font-weight: 600; }
.pussycat-settings-tabs { display: flex; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid rgb(38 44 56 / 88%); }
.pussycat-settings-tab, .pussycat-diagnostics-refresh {
  padding: 8px 14px; border: 1px solid rgb(38 44 56 / 88%); border-radius: 7px;
  background: transparent; color: #9aa4b2; cursor: pointer;
}
.pussycat-settings-tab[aria-selected="true"] { background: rgb(79 140 255 / 18%); border-color: rgb(79 140 255 / 34%); color: #f6f9ff; }
.pussycat-diagnostics { padding: 16px 0; }
.pussycat-diagnostics[hidden] { display: none !important; }
.pussycat-diagnostics-refresh { margin-bottom: 12px; color: #e6e9ef; }
.pussycat-diagnostics-log {
  max-height: 65vh; margin: 0; padding: 16px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  border: 1px solid rgb(38 44 56 / 88%); border-radius: 8px; background: #0f1115; color: #b9c5d8;
  font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
}
#main.is-pussycat-log-view > .arco-layout { display: none !important; }
.pussycat-wechat-note { margin: 0 24px 16px; color: #9aa4b2; }
.wechat-status-page .account-header { background: linear-gradient(135deg, #171a21 0%, #202632 100%) !important; color: #e6e9ef !important; }
.wechat-status-page .token-section { background: #171a21 !important; color: #e6e9ef !important; }
.wechat-status-page .token-value { background: #0f1115 !important; color: #b9c5d8 !important; }
`
const WRSS_UI_JS = `(() => {
  const VERSION = 'pussycat-wrss-ui-v7'
  const previous = window.__PUSSYCAT_WRSS_UI__
  if (previous && previous.version === VERSION) return
  if (previous && typeof previous.destroy === 'function') previous.destroy()

  const state = {
    version: VERSION,
    raf: 0,
    observer: null,
    cleanup: [],
    moreWrap: null,
    menuButton: null,
    menuPanel: null,
    menuScrim: null,
    brand: null,
    menuCloseButton: null,
    bodyOverflow: null,
    articleToolbar: null,
    articleToolbarPlaceholder: null,
    settingsPanel: null,
    prefetchKey: '',
    route: window.location.pathname,
    logsMode: false,
    diagnosticsText: '正在读取运行日志…',
    refreshTimer: null,
  }
  window.__PUSSYCAT_WRSS_UI__ = state

  const primaryNav = [
    { from: '订阅管理', label: '订阅与文章', path: '/', order: '1' },
    { from: '导出记录', label: '导出记录', path: '/export/records', order: '2' },
    { from: '授权管理', label: '微信授权', path: '/wechat-status', order: '3' },
  ]
  const moreNav = [
    { from: '标签管理', label: '标签管理', path: '/tags', group: '整理与自动化', description: '按主题整理公众号' },
    { from: '消息任务', label: '消息任务', path: '/message-tasks', group: '整理与自动化', description: '定时更新并向指定渠道推送' },
    { from: '过滤规则', label: '过滤规则', path: '/filter-rules', group: '整理与自动化', description: '清理采集文章中的指定内容' },
    { from: '任务队列', label: '任务队列', path: '/task-queue', group: '整理与自动化', description: '查看正在运行和等待的采集任务' },
    { from: '公众号状态', label: '采集状态', path: '/cascade/feed-status', group: '整理与自动化', description: '查看各公众号的采集进度' },
    { from: '级联管理', label: '级联管理', path: '/cascade', group: '高级与诊断', description: '多台WeRSS服务器之间分配采集任务' },
    { from: 'Access Key', label: 'Access Key', path: '/access-keys', group: '高级与诊断', description: '让其他程序访问本机WeRSS接口' },
    { from: '异常统计', label: '异常统计', path: '/env-exception', group: '高级与诊断', description: '查看抓取异常' },
    { from: '配置信息', label: '设置与诊断', path: '/configs', group: '高级与诊断', description: '配置参数并查看运行日志' },
  ]
  const settingsNav = [
    { from: '配置信息', label: '配置信息', path: '/configs' },
    { from: '系统信息', label: '系统信息', path: '/sys-info', group: '高级与诊断', description: '查看版本与文章统计' },
  ]
  const menuNav = moreNav
  const headerLinks = new Set(['Views', 'Docs', 'Gitee', 'GitHub', 'ClawCloud', '云部署', '支持', '赞助'])

  function normalize(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim()
  }
  function wechatLoginState() {
    return window.__PUSSYCAT_WRSS_AUTH__?.getState?.()?.login
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

  function replaceExactText(element, replacements) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node = null
    while ((node = walker.nextNode())) {
      const replacement = replacements.get(normalize(node.nodeValue))
      if (replacement) node.nodeValue = replacement
    }
  }

  function entryFor(item) {
    const text = normalize(item.textContent)
    const storedPath = item.dataset.pussycatPath
    return [...primaryNav, ...settingsNav, ...moreNav].find((entry) => storedPath === entry.path || text.includes(entry.from) || text === entry.label)
  }

  function closeMore() {
    if (!state.moreWrap) return
    const wasOpen = state.moreWrap.classList.contains('is-open')
    state.moreWrap.classList.remove('is-open')
    const button = state.menuButton || state.moreWrap.querySelector('.pussycat-more-button')
    if (button) button.setAttribute('aria-expanded', 'false')
    if (state.menuScrim) state.menuScrim.classList.remove('is-visible')
    if (state.menuPanel) {
      state.menuPanel.setAttribute('inert', '')
      state.menuPanel.classList.remove('is-open')
    }
    if (state.bodyOverflow !== null) {
      document.body.style.overflow = state.bodyOverflow
      state.bodyOverflow = null
    }
    if (wasOpen && button && document.activeElement !== button) button.focus()
  }

  function openMore() {
    if (!state.moreWrap || !state.menuButton) return
    state.moreWrap.classList.add('is-open')
    state.menuButton.setAttribute('aria-expanded', 'true')
    if (state.menuScrim) state.menuScrim.classList.add('is-visible')
    if (state.menuPanel) {
      state.menuPanel.removeAttribute('inert')
      state.menuPanel.classList.add('is-open')
    }
    if (state.bodyOverflow === null) state.bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    state.menuPanel?.querySelector('.pussycat-more-item')?.focus()
  }

  function attrValue(value) {
    return String(value).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"')
  }

  function navigate(path) {
    state.logsMode = false
    closeMore()
    schedule()
    const selector = '.arco-menu-item[data-pussycat-path="' + attrValue(path) + '"]'
    const menuItem = document.querySelector(selector)
    if (menuItem instanceof HTMLElement) {
      menuItem.click()
      return
    }
    window.location.assign(path)
  }

  function ensureMoreMenu(menu) {
    const host = document.querySelector('#main > .arco-layout-header')
    if (!host) return
    if (host.tagName !== 'HEADER') host.setAttribute('role', 'banner')
    else host.removeAttribute('role')
    menu.setAttribute('role', 'navigation')
    menu.setAttribute('aria-label', 'Main')
    if (!host.querySelector('.pussycat-brand')) {
      const brand = document.createElement('div')
      brand.className = 'pussycat-brand'
      brand.innerHTML = '<span class="pussycat-brand-mark" aria-hidden="true"></span><span>公众号</span>'
      host.insertBefore(brand, menu)
      state.brand = brand
    }
    let wrap = Array.from(host.children).find((child) => child.classList && child.classList.contains('pussycat-more-wrap'))
    if (!wrap) {
      wrap = document.createElement('div')
      wrap.className = 'pussycat-more-wrap'
      wrap.innerHTML = '<button type="button" class="pussycat-more-button" aria-haspopup="true" aria-expanded="false" aria-controls="pussycat-wrss-nav" aria-label="打开公众号更多操作"><span aria-hidden="true"><span></span><span></span><span></span></span><span>更多</span></button>'
      host.appendChild(wrap)
      const button = wrap.querySelector('.pussycat-more-button')
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        if (wrap.classList.contains('is-open')) closeMore()
        else openMore()
      })
      state.menuButton = button
    }
    state.moreWrap = wrap
    if (!state.menuPanel) {
      const panel = document.createElement('nav')
      panel.id = 'pussycat-wrss-nav'
      panel.className = 'pussycat-more-menu'
      panel.setAttribute('aria-label', '公众号菜单')
      panel.setAttribute('inert', '')
      panel.innerHTML = '<button type="button" class="pussycat-drawer-close" aria-label="关闭公众号菜单">关闭</button><section class="pussycat-article-actions" aria-label="文章操作" hidden><h2>文章操作</h2></section><div class="pussycat-drawer-items"></div>'
      state.menuPanel = panel
      state.menuCloseButton = panel.querySelector('.pussycat-drawer-close')
      state.menuCloseButton.addEventListener('click', () => closeMore())
      const scrim = document.createElement('button')
      scrim.type = 'button'
      scrim.className = 'pussycat-menu-scrim'
      scrim.setAttribute('aria-label', '关闭公众号菜单')
      scrim.addEventListener('click', () => closeMore())
      document.body.append(scrim, panel)
      state.menuScrim = scrim
    }

    const panel = state.menuPanel
    if (!panel) return
    panel.setAttribute('aria-label', '公众号菜单')
    const items = panel.querySelector('.pussycat-drawer-items') || panel
    const activePath = window.location.pathname === '/sys-info' ? '/configs' : window.location.pathname
    const authorized = wechatLoginState() === true
    const signature = activePath + '|' + authorized + '|' + menuNav.map((entry) => entry.path + ':' + entry.label).join(',')
    if (panel.dataset.pussycatSignature === signature) return
    panel.dataset.pussycatSignature = signature
    const nodes = []
    let group = ''
    menuNav.forEach((entry) => {
      if (entry.group !== group) {
        group = entry.group
        const heading = document.createElement('h2')
        heading.className = 'pussycat-menu-group'
        heading.textContent = group
        nodes.push(heading)
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'pussycat-more-item'
      if (activePath === entry.path) button.setAttribute('aria-current', 'page')
      button.textContent = entry.label
      button.title = entry.description
      button.addEventListener('click', () => navigate(entry.path))
      nodes.push(button)
    })
    if (authorized) {
      const heading = document.createElement('h2')
      heading.className = 'pussycat-menu-group'
      heading.textContent = '账户'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'pussycat-more-item pussycat-wechat-logout'
      button.textContent = '退出登录'
      button.addEventListener('click', async () => {
        button.disabled = true
        panel.querySelector('.pussycat-menu-alert')?.remove()
        try {
          await window.__PUSSYCAT_WRSS_AUTH__.logout()
          closeMore()
        } catch (error) {
          const alert = document.createElement('p')
          alert.className = 'pussycat-menu-alert'
          alert.setAttribute('role', 'alert')
          alert.textContent = error?.message || '退出登录失败'
          button.after(alert)
        } finally {
          button.disabled = false
          schedule()
        }
      })
      nodes.push(heading, button)
    }
    items.replaceChildren(...nodes)
  }

  function enhanceNav() {
    const menu = document.querySelector('#main > .arco-layout-header .arco-menu-horizontal, #main > .arco-layout-header .arco-menu')
    if (!menu) return

    menu.querySelectorAll('.arco-menu-item').forEach((item) => {
      const entry = entryFor(item)
      if (!entry) return
      item.dataset.pussycatPath = entry.path
      item.classList.toggle('pussycat-primary-nav', primaryNav.some((nav) => nav.path === entry.path))
      item.classList.toggle('pussycat-low-nav', [...moreNav, ...settingsNav].some((nav) => nav.path === entry.path))
      if (entry.order) item.style.order = entry.order
      if (primaryNav.some((nav) => nav.path === entry.path)) {
        if (window.location.pathname === entry.path) item.setAttribute('aria-current', 'page')
        else item.removeAttribute('aria-current')
      }
      setLastTextNode(item, entry.label)
    })

    ensureMoreMenu(menu)
  }

  function enhanceHeaderLinks() {
    document.querySelectorAll('.app-header .header-right a').forEach((link) => {
      if (headerLinks.has(normalize(link.textContent))) link.classList.add('pussycat-hidden-link')
    })
  }

  function renderEmptyState(container, key, visible, label) {
    if (!container) return
    const selector = '.pussycat-empty-state[data-pussycat-empty="' + key + '"]'
    const current = container.querySelector(selector)
    if (!visible) {
      current?.remove()
      return
    }
    if (current) return
    const empty = document.createElement('div')
    empty.className = 'pussycat-empty-state'
    empty.dataset.pussycatEmpty = key
    empty.setAttribute('role', 'status')
    empty.textContent = label
    container.append(empty)
  }

  function restoreArticleToolbar() {
    if (state.articleToolbarPlaceholder?.isConnected) state.articleToolbarPlaceholder.replaceWith(state.articleToolbar)
    else state.articleToolbar?.remove()
    state.articleToolbar = null
    state.articleToolbarPlaceholder = null
  }

  function enhancePopups() {
    document.querySelectorAll('.arco-popover-popup-content *, .arco-popconfirm-popup-content *').forEach((element) => {
      element.classList.toggle('pussycat-popup-id-row', element.children.length === 0 && /^ID:\\s*\\S/.test(normalize(element.textContent)))
    })
  }

  function enhanceArticles() {
    const articleList = document.querySelector('.article-list')
    const actions = state.menuPanel?.querySelector('.pussycat-article-actions')
    if (!actions) return
    if (state.articleToolbar && (!articleList?.contains(state.articleToolbarPlaceholder) || window.location.pathname !== '/')) restoreArticleToolbar()
    const toolbar = articleList?.querySelector('.arco-page-header-extra')
    const sourceSearch = articleList?.querySelector('.arco-layout-sider input[placeholder*="搜索公众号"], .arco-layout-sider input[placeholder*="公众号名称"], .pussycat-source-search input')
    const sourceList = articleList?.querySelector('.arco-layout-sider .arco-list')
    if (sourceSearch && !sourceSearch.dataset.pussycatMoved) {
      const holder = sourceSearch.closest('.arco-input-group, .arco-form-item, .arco-input-wrapper') || sourceSearch.parentElement
      const target = articleList?.querySelector('.arco-layout-content .arco-page-header-extra')
      if (holder && target) {
        holder.dataset.pussycatMoved = '1'
        holder.classList.add('pussycat-source-search')
        target.prepend(holder)
        let recent = []
        try { recent = JSON.parse(localStorage.getItem('pussycat-recent-mps') || '[]') } catch {}
        if (!Array.isArray(recent)) recent = []
        if (recent.length && !target.querySelector('.pussycat-frequent-group')) {
          const group = document.createElement('div')
          group.className = 'pussycat-frequent-group'
          group.innerHTML = '<span>常看的</span>' + recent.slice(0, 5).map((name) => '<button type="button">' + String(name).replace(/[&<>"']/g, '') + '</button>').join('')
          group.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
            sourceSearch.value = button.textContent
            sourceSearch.dispatchEvent(new Event('input', { bubbles: true }))
          }))
          target.append(group)
        }
      }
    }
    if (!state.articleToolbar && toolbar && window.location.pathname === '/') {
      const placeholder = document.createComment('article actions')
      toolbar.before(placeholder)
      actions.appendChild(toolbar)
      state.articleToolbar = toolbar
      state.articleToolbarPlaceholder = placeholder
    }
    actions.hidden = !state.articleToolbar
    if (state.articleToolbar) {
      replaceExactText(state.articleToolbar, new Map([
        ['内链', '在应用内阅读'],
        ['订阅', '订阅链接'],
      ]))
      state.articleToolbar.querySelectorAll('button').forEach((button) => {
        if (normalize(button.textContent) === '刷新授权') button.classList.add('pussycat-hidden-link')
      })
    }
    const sourceTitle = articleList?.querySelector('.arco-layout-sider .arco-card-header-title')
    if (sourceTitle) setLastTextNode(sourceTitle, '已订阅公众号')
    articleList?.querySelectorAll('.arco-layout-sider .arco-card-header-extra button').forEach((button) => {
      if (normalize(button.textContent) === '订阅') setLastTextNode(button, '添加公众号')
    })
    const list = sourceList
    if (list) {
      list.setAttribute('role', 'navigation')
      list.setAttribute('aria-label', '公众号')
      list.querySelectorAll('.arco-list-item').forEach((item) => {
        const image = item.querySelector('img')
        const label = item.querySelector('.arco-typography')
        if (image?.getAttribute('src') === '/static/logo.svg' && label) {
          const replacement = new Map([
            ['全部', '最新文章'],
            ['精选文章', '我的收藏'],
          ]).get(normalize(label.textContent))
          if (replacement) setLastTextNode(label, replacement)
        }
        if (item.classList.contains('active-mp')) item.setAttribute('aria-current', 'page')
        else item.removeAttribute('aria-current')
      })
      renderEmptyState(list, 'source-search', Boolean(sourceSearch && normalize(sourceSearch.value) && list.querySelectorAll('.arco-list-item').length === 0), '没有匹配的公众号')
    }
    const articleResults = articleList?.querySelector('.arco-layout-content .arco-list')
    if (articleResults) renderEmptyState(articleResults, 'article-results', articleResults.querySelectorAll('.arco-list-item').length === 0, '暂无文章')
    const pageTitle = articleList?.querySelector('.arco-layout-content .arco-page-header-title')
    if (pageTitle) replaceExactText(pageTitle, new Map([
      ['全部', '最新文章'],
      ['精选文章', '我的收藏'],
    ]))
    articleList?.querySelectorAll('.arco-alert').forEach((alert) => replaceExactText(alert, new Map([
      ['请选择一个公众号码进行管理,搜索文章后再点击订阅会有惊喜哟！！！', '选择公众号查看文章；添加公众号后可更新内容。'],
      ['显示所有公众号文章', '选择公众号查看文章；添加公众号后可更新内容。'],
      ['用户手动添加的精选文章', '选择公众号查看文章；添加公众号后可更新内容。'],
    ])))
    articleList?.querySelectorAll('button').forEach((button) => {
      if (!/^刷新/.test(normalize(button.textContent))) return
      const key = 'pussycat-wechat-last-refresh'
      const last = Number(localStorage.getItem(key) || 0)
      const remain = Math.max(0, 300000 - (Date.now() - last))
      button.disabled = remain > 0
      if (remain > 0 && !state.refreshTimer) {
        state.refreshTimer = window.setTimeout(() => { state.refreshTimer = null; schedule() }, remain + 20)
      }
      if (!button.dataset.pussycatCooldown) {
        button.dataset.pussycatCooldown = '1'
        button.addEventListener('click', () => localStorage.setItem(key, String(Date.now())), { capture: true })
      }
    })
    articleList?.querySelectorAll('*').forEach((element) => {
      if (element.children.length || !/^共\s*\d+\s*条$/.test(normalize(element.textContent))) return
      element.classList.add('pussycat-count-hidden')
    })
    articleList?.querySelectorAll('.arco-trigger-popup, .arco-dropdown-menu, .arco-select-popup').forEach((popup) => { popup.style.zIndex = '1200' })
    document.querySelectorAll('.arco-trigger-popup, .arco-modal-wrapper').forEach((popup) => replaceExactText(popup, new Map([
      ['添加精选文章', '收录单篇文章'],
    ])))
  }

  function enhanceWechatStatus() {
    const page = document.querySelector('.wechat-status-page')
    if (!page) return
    const title = page.querySelector('.arco-page-header-title')
    if (title) setLastTextNode(title, '微信授权')
    page.querySelectorAll('button').forEach((button) => {
      const text = normalize(button.textContent)
      if (text === '刷新Token' || text === '切换账号') button.classList.add('pussycat-hidden-link')
      if (text === '扫码授权') button.classList.toggle('pussycat-wechat-authorized-hidden', wechatLoginState() === true)
    })
    const login = wechatLoginState()
    const authorized = login === true
    page.querySelectorAll('.action-card').forEach((card) => card.classList.toggle('pussycat-wechat-authorized-hidden', authorized))
    const prefetchKey = window.location.pathname === '/wechat-status' && login === false ? 'wechat-status:unauthorized' : ''
    if (prefetchKey && state.prefetchKey !== prefetchKey) window.__PUSSYCAT_WRSS_AUTH__?.prefetch?.().catch(() => {})
    state.prefetchKey = prefetchKey
    if (!page.querySelector('.pussycat-wechat-note')) {
      const note = document.createElement('p')
      note.className = 'pussycat-wechat-note'
      note.textContent = '微信授权会保存在本机，重启后复用；到期或微信使其失效后，需要重新扫码。'
      const header = page.querySelector('.arco-page-header')
      if (header) header.after(note)
      else page.prepend(note)
    }
  }

  function requestDiagnostics() {
    state.diagnosticsText = '正在读取运行日志…'
    window.parent.postMessage({ type: 'pussycat-wrss-diagnostics-request' }, '*')
    schedule()
  }

  function enhanceSettings() {
    const route = window.location.pathname
    if (state.route !== route) {
      state.route = route
      state.logsMode = false
    }
    const main = document.getElementById('main')
    const onSettingsRoute = route === '/configs' || route === '/sys-info'
    if (!main || !onSettingsRoute) {
      if (state.settingsPanel) state.settingsPanel.remove()
      state.settingsPanel = null
      if (main) main.classList.remove('is-pussycat-log-view')
      return
    }
    const content = main.querySelector(':scope > section.arco-layout')
    if (!content) return
    let panel = state.settingsPanel
    if (!panel || !main.contains(panel)) {
      panel = document.createElement('section')
      panel.id = 'pussycat-settings-panel'
      panel.setAttribute('aria-label', '设置与诊断')
      const heading = document.createElement('h2')
      heading.className = 'pussycat-settings-heading'
      heading.textContent = '设置与诊断'
      const tabs = document.createElement('div')
      tabs.className = 'pussycat-settings-tabs'
      tabs.setAttribute('role', 'tablist')
      tabs.setAttribute('aria-label', '设置与诊断')
      ;[
        { id: 'configs', label: '配置信息', path: '/configs' },
        { id: 'sys-info', label: '系统信息', path: '/sys-info' },
        { id: 'logs', label: '运行日志' },
      ].forEach((entry) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'pussycat-settings-tab'
        button.dataset.settingsTab = entry.id
        button.textContent = entry.label
        button.setAttribute('role', 'tab')
        button.addEventListener('click', () => {
          if (entry.path) navigate(entry.path)
          else {
            state.logsMode = true
            requestDiagnostics()
          }
          schedule()
        })
        tabs.appendChild(button)
      })
      const diagnostics = document.createElement('div')
      diagnostics.className = 'pussycat-diagnostics'
      const refresh = document.createElement('button')
      refresh.type = 'button'
      refresh.className = 'pussycat-diagnostics-refresh'
      refresh.textContent = '刷新日志'
      refresh.addEventListener('click', requestDiagnostics)
      const log = document.createElement('pre')
      log.className = 'pussycat-diagnostics-log'
      log.setAttribute('aria-label', '运行日志')
      diagnostics.append(refresh, log)
      panel.append(heading, tabs, diagnostics)
      main.insertBefore(panel, content)
      state.settingsPanel = panel
    }
    main.classList.toggle('is-pussycat-log-view', state.logsMode)
    const active = state.logsMode ? 'logs' : route.slice(1)
    panel.querySelectorAll('.pussycat-settings-tab').forEach((button) => {
      button.setAttribute('aria-selected', button.dataset.settingsTab === active ? 'true' : 'false')
    })
    panel.querySelector('.pussycat-diagnostics').hidden = !state.logsMode
    const log = panel.querySelector('.pussycat-diagnostics-log')
    if (log.textContent !== state.diagnosticsText) log.textContent = state.diagnosticsText
  }

  const onDiagnostics = (event) => {
    if (event.source !== window.parent || event.data?.type !== 'pussycat-wrss-diagnostics') return
    const data = event.data
    if (typeof data.error === 'string') state.diagnosticsText = data.error
    else if (data.status) {
      const status = data.status
      state.diagnosticsText = [
        '状态: ' + String(status.state || '—'),
        '说明: ' + String(status.summary || '—'),
        'reason_code: ' + String(status.reason_code || '—'),
        '',
        '运行日志',
        ...(Array.isArray(status.progress_log) ? status.progress_log.map(String) : []),
      ].join('\\n')
    }
    schedule()
  }
  const onPopState = () => { state.logsMode = false; schedule() }
  const onWechatStatus = () => schedule()
  window.addEventListener('message', onDiagnostics)
  window.addEventListener('popstate', onPopState)
  window.addEventListener('pussycat-wechat-auth-change', onWechatStatus)
  state.cleanup.push(() => window.removeEventListener('message', onDiagnostics))
  state.cleanup.push(() => window.removeEventListener('popstate', onPopState))
  state.cleanup.push(() => window.removeEventListener('pussycat-wechat-auth-change', onWechatStatus))

  function apply() {
    state.raf = 0
    document.body.setAttribute('arco-theme', 'dark')
    enhanceHeaderLinks()
    enhanceNav()
    enhanceArticles()
    enhancePopups()
    enhanceWechatStatus()
    enhanceSettings()
  }

  function schedule() {
    if (state.raf) return
    state.raf = window.requestAnimationFrame(apply)
  }

  const onDocumentClick = (event) => {
    if (event.target.closest?.('.arco-trigger-popup, .arco-modal-wrapper')) return
    if (state.moreWrap && !state.moreWrap.contains(event.target) && !state.menuPanel?.contains(event.target)) closeMore()
  }
  const onKeyDown = (event) => {
    if (event.target.closest?.('.arco-trigger-popup, .arco-modal-wrapper')) return
    if (event.key === 'Escape') {
      closeMore()
      return
    }
    if (event.key !== 'Tab' || !state.moreWrap?.classList.contains('is-open') || !state.menuPanel) return
    const focusable = [...state.menuPanel.querySelectorAll('button:not([disabled])')]
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
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

  state.observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.type === 'childList' || mutation.target.matches('.article-list .arco-list-item'))) schedule()
  })
  state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  state.destroy = () => {
    closeMore()
    if (state.raf) window.cancelAnimationFrame(state.raf)
    if (state.observer) state.observer.disconnect()
    state.cleanup.forEach((cleanup) => cleanup())
    restoreArticleToolbar()
    if (state.settingsPanel) state.settingsPanel.remove()
    if (state.brand) state.brand.remove()
    if (state.moreWrap) state.moreWrap.remove()
    if (state.menuPanel) state.menuPanel.remove()
    if (state.menuScrim) state.menuScrim.remove()
    document.getElementById('main')?.classList.remove('is-pussycat-log-view')
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
  ensureWrssSourcePatches(sourceDir)
  const staticDir = join(sourceDir, 'static')
  const indexPath = join(staticDir, 'index.html')
  if (!isRegularFile(indexPath)) throw new WrssRuntimeError(500, 'security-patch-mismatch', 'WeRSS 页面模板不存在')
  const indexHtml = readFileSync(indexPath, 'utf8')
  const headMatches = indexHtml.match(/<\/head>/gi) ?? []
  if (headMatches.length !== 1) throw new WrssRuntimeError(500, 'security-patch-mismatch', 'WeRSS 页面模板不符合预期')
  const withoutManagedAssets = indexHtml
    .replace(/\s*<script\b[^>]*\bsrc=["']https?:\/\/hm\.baidu\.com\/hm\.js(?:\?[^"']*)?["'][^>]*>\s*<\/script>/gi, '')
    .replace(/\s*<script\s+src=["']\/static\/pussycat-ui\.js["']><\/script>/gi, '')
    .replace(/\s*<script\s+src=["']\/static\/pussycat-auth\.js["']><\/script>/gi, '')
    .replace(/\s*<script\s+src=["']\/static\/pussycat-bootstrap\.js["']><\/script>/gi, '')
    .replace(/\s*<link\s+rel=["']stylesheet["']\s+href=["']\/static\/pussycat-theme\.css["']\s*\/?>/gi, '')
  atomicText(indexPath, withoutManagedAssets.replace(/<\/head>/i, `${WRSS_THEME_LINK}\n${WRSS_BOOTSTRAP_SCRIPT}\n${WRSS_AUTH_SCRIPT}\n${WRSS_UI_SCRIPT}\n</head>`))
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
