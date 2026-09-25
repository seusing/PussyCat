// @vitest-environment node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { wrssPinBundle, wrssPinPython, wrssPinSuccess, wrssPinWechatStatus } from '../test-fixtures/wrss-pin.mjs'
import { ensureWrssStaticAssets } from './wrss-runtime.mjs'

let sourceDir

afterEach(() => {
  if (sourceDir) rmSync(sourceDir, { recursive: true, force: true })
  sourceDir = undefined
})

it('clarifies navigation, article actions, sources, and local WeChat authorization without replacing behavior', async () => {
  sourceDir = await mkdtemp(join(tmpdir(), 'wrss-navigation-'))
  mkdirSync(join(sourceDir, 'static', 'assets'), { recursive: true })
  mkdirSync(join(sourceDir, 'driver'), { recursive: true })
  writeFileSync(join(sourceDir, 'static', 'index.html'), '<html><head></head><body></body></html>')
  writeFileSync(join(sourceDir, 'static', 'assets', 'index.a75a6e55.js'), wrssPinBundle)
  writeFileSync(join(sourceDir, 'static', 'assets', 'WechatStatus.62cf3d3b.js'), wrssPinWechatStatus)
  writeFileSync(join(sourceDir, 'driver', 'wx.py'), wrssPinPython)
  writeFileSync(join(sourceDir, 'driver', 'success.py'), wrssPinSuccess)
  ensureWrssStaticAssets(sourceDir)

  const css = readFileSync(join(sourceDir, 'static', 'pussycat-theme.css'), 'utf8')
  const script = readFileSync(join(sourceDir, 'static', 'pussycat-ui.js'), 'utf8')
  const dom = new JSDOM(`<style>${css}</style>
    <div class="app-header"><button>重复扫码</button></div>
    <div id="main">
      <header class="arco-layout-header"><div class="arco-menu">
        <button class="arco-menu-item" data-route="/">订阅管理</button>
        <button class="arco-menu-item" data-route="/export/records">导出记录</button>
        <button class="arco-menu-item" data-route="/wechat-status">授权管理</button>
        <button class="arco-menu-item" data-route="/tags">标签管理</button>
        <button class="arco-menu-item" data-route="/message-tasks">消息任务</button>
        <button class="arco-menu-item" data-route="/filter-rules">过滤规则</button>
        <button class="arco-menu-item" data-route="/task-queue">任务队列</button>
        <button class="arco-menu-item" data-route="/cascade/feed-status">公众号状态</button>
        <button class="arco-menu-item" data-route="/cascade">级联管理</button>
        <button class="arco-menu-item" data-route="/access-keys">Access Key</button>
        <button class="arco-menu-item" data-route="/env-exception">异常统计</button>
        <button class="arco-menu-item" data-route="/configs">配置信息</button>
        <button class="arco-menu-item" data-route="/sys-info">系统信息</button>
      </div></header>
      <section class="article-list arco-layout">
        <aside class="arco-layout-sider"><section class="arco-card">
          <header><h2 class="arco-card-header-title">公众号</h2><div class="arco-card-header-extra"><button><span>订阅</span></button></div></header>
          <div><span class="arco-input-wrapper"><input placeholder="搜索公众号名称"></span></div>
          <div><span class="arco-radio-group-button"><label>全部</label><label>启用</label><label>停用</label></span></div>
          <div class="arco-list">
            <button class="arco-list-item active-mp"><img src="/static/logo.svg"><strong class="arco-typography">全部</strong></button>
            <button class="arco-list-item"><img src="/static/logo.svg"><strong class="arco-typography">精选文章</strong></button>
            <button class="arco-list-item"><img src="/avatar.png"><strong class="arco-typography">真实公众号</strong></button>
          </div>
          <div class="arco-pagination"><span class="arco-pagination-total">共 21 条</span><button class="arco-pagination-item-previous">上一页</button><span class="arco-pagination-jumper">1 / 2</span><button class="arco-pagination-item-next">下一页</button></div>
        </section></aside>
        <main class="arco-layout-content"><header class="arco-page-header">
          <div class="arco-page-header-header"><span class="arco-page-header-main"><h1 class="arco-page-header-title">全部</h1></span>
            <div class="arco-page-header-extra"><span>内链</span><button>刷新授权</button><button>订阅</button></div>
          </div>
        </header><div class="arco-alert">请选择一个公众号码进行管理,搜索文章后再点击订阅会有惊喜哟！！！</div>
          <div class="search-bar"><span class="arco-input-wrapper arco-input-search search-input"><input placeholder="搜索文章标题"></span><span class="arco-select article-filter-select">个别内容</span><button>列设置</button></div>
        </main>
      </section>
      <section class="wechat-status-page"><header class="arco-page-header"><h1 class="arco-page-header-title">公众号状态</h1><button>刷新状态</button></header>
        <div class="account-header">账户</div><div class="token-section"><div class="token-value">token</div></div>
        <button id="scan">扫码授权</button><button id="token-refresh">刷新Token</button>
      </section>
    </div>
    <div id="auth-modal" class="arco-modal-wrapper">微信授权弹窗</div>
    <div class="arco-trigger-popup"><button>添加精选文章</button></div>
    <div class="arco-trigger-popup arco-popover"><div class="arco-popover-popup-content">显示所有公众号文章</div></div>
    <div class="arco-trigger-popup arco-popover" data-interactive-popup><div class="arco-popover-popup-content"><button>删除</button></div></div>`, {
    url: 'http://127.0.0.1:43202/', pretendToBeVisual: true, runScripts: 'outside-only',
  })
  const { window } = dom
  const { document } = window
  const navigate = vi.fn()
  const accountClick = vi.fn()
  const prefetch = vi.fn().mockResolvedValue({ code: '/qr' })
  window.__PUSSYCAT_WRSS_AUTH__ = { getState: () => ({ login: false }), prefetch, logout: vi.fn() }
  document.querySelectorAll('[data-route]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.route)))
  document.querySelector('.arco-list-item:last-child').addEventListener('click', accountClick)
  try {
    window.eval(script)
    await vi.waitFor(() => expect(document.querySelector('.pussycat-more-menu')).not.toBeNull())

    expect(window.getComputedStyle(document.querySelector('.app-header')).display).toBe('none')
    expect(document.querySelector('[data-route="/wechat-status"]').textContent.trim()).toBe('微信授权')
    expect(document.querySelector('.wechat-status-page .arco-page-header-title').textContent).toBe('微信授权')
    expect(window.getComputedStyle(document.getElementById('token-refresh')).display).toBe('none')
    expect(document.getElementById('scan').classList.contains('pussycat-hidden-link')).toBe(false)
    expect(window.getComputedStyle(document.getElementById('auth-modal')).display).not.toBe('none')
    expect(document.querySelector('.pussycat-wechat-note').textContent).toBe('微信授权会保存在本机，重启后复用；到期或微信使其失效后，需要重新扫码。')
    expect(prefetch).not.toHaveBeenCalled()

    expect(document.querySelector('.arco-card-header-title').textContent).toBe('已订阅公众号')
    expect(window.getComputedStyle(document.querySelector('.arco-card-header-title')).display).toBe('none')
    expect(document.querySelector('.arco-card-header-extra button').textContent).toBe('添加公众号')
    expect([...document.querySelectorAll('.arco-list-item .arco-typography')].map((node) => node.textContent)).toEqual(['最新文章', '我的收藏', '已订阅公众号', '真实公众号'])
    expect(document.querySelector('.article-list .arco-page-header-title').textContent).toBe('最新文章')
    expect(document.querySelector('.arco-alert').textContent).toBe('选择公众号查看文章；添加公众号后可更新内容。')
    const headerActions = document.querySelector('.article-list .arco-page-header-extra')
    expect(headerActions.parentElement.className).toBe('arco-page-header-header')
    expect(headerActions.textContent).toContain('在应用内阅读')
    expect(headerActions.textContent).toContain('订阅链接')
    expect(window.getComputedStyle([...headerActions.querySelectorAll('button')].find((button) => button.textContent.trim() === '刷新授权')).display).toBe('none')
    const articleSearch = document.querySelector('.pussycat-article-search')
    expect(articleSearch.parentElement.className).toBe('arco-page-header-header')
    expect(articleSearch.querySelector('input').placeholder).toBe('搜索文章标题')
    expect(articleSearch.querySelector('.article-filter-select').textContent).toBe('个别内容')
    expect(document.querySelector('.search-bar button').textContent).toBe('列设置')
    expect(window.getComputedStyle(document.querySelector('.pussycat-source-account')).display).toBe('none')
    expect(window.getComputedStyle(document.querySelector('.arco-card-header-extra')).display).toBe('none')
    expect(window.getComputedStyle(document.querySelector('.arco-pagination')).display).toBe('none')
    document.querySelector('.pussycat-sources-entry').click()
    await vi.waitFor(() => expect(document.querySelector('.article-list').dataset.pussycatSourceMode).toBe('sources'))
    expect(window.getComputedStyle(document.querySelector('.pussycat-source-account')).display).toBe('none')
    expect(window.getComputedStyle(document.querySelector('.pussycat-source-cards')).display).not.toBe('none')
    expect(window.getComputedStyle(document.querySelector('.arco-card-header-extra')).display).not.toBe('none')
    expect(window.getComputedStyle(document.querySelector('.arco-pagination')).display).not.toBe('none')
    expect(window.getComputedStyle(document.querySelector('.arco-pagination-total')).display).toBe('none')
    expect(window.getComputedStyle(document.querySelector('.arco-pagination-jumper')).display).toBe('none')
    expect(window.getComputedStyle(document.querySelector('.arco-pagination-item-next')).display).not.toBe('none')
    document.querySelector('.pussycat-source-account').click()
    expect(accountClick).toHaveBeenCalledOnce()
    expect(document.querySelector('.arco-trigger-popup').textContent).toContain('收录单篇文章')

    const groups = [...document.querySelectorAll('.pussycat-menu-group')].map((heading) => heading.textContent)
    expect(groups).toEqual(['整理与自动化', '高级与诊断'])
    const menuLabels = [...document.querySelectorAll('.pussycat-more-item')].map((button) => button.textContent)
    expect(menuLabels).toContain('设置与诊断')
    expect(menuLabels).not.toContain('系统信息')
    expect(document.querySelector('.pussycat-more-button').textContent).toContain('更多')
    expect(css).toMatch(/#main > \.arco-layout\s*\{[^}]*background:\s*#0f1115/s)
    expect(script).toContain('transitionPrimaryRoute')
    expect(script).toContain("translate3d('")
    expect(document.querySelector('.arco-trigger-popup.arco-popover:not([data-interactive-popup])')).toHaveClass('pussycat-passive-tooltip')
    expect(document.querySelector('[data-interactive-popup]')).not.toHaveClass('pussycat-passive-tooltip')
    const collectionStatus = [...document.querySelectorAll('.pussycat-more-item')].find((button) => button.textContent === '采集状态')
    expect(collectionStatus.title).toBe('查看各公众号的采集进度')
    collectionStatus.click()
    expect(navigate).toHaveBeenCalledWith('/cascade/feed-status')

    window.history.pushState({}, '', '/sys-info')
    window.dispatchEvent(new window.PopStateEvent('popstate'))
    await vi.waitFor(() => expect([...document.querySelectorAll('.pussycat-more-item')]
      .find((button) => button.textContent === '设置与诊断')?.getAttribute('aria-current')).toBe('page'))

    const firstMenuItem = document.querySelector('.pussycat-more-item')
    const modal = document.getElementById('auth-modal')
    document.querySelector('.arco-alert').append(document.createElement('span'))
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    expect(document.querySelector('.pussycat-more-item')).toBe(firstMenuItem)
    expect(document.getElementById('auth-modal')).toBe(modal)
  } finally {
    window.__PUSSYCAT_WRSS_UI__?.destroy()
    window.close()
  }
})

it('animates the real nested route root only after a lazy primary route commits', async () => {
  sourceDir = await mkdtemp(join(tmpdir(), 'wrss-navigation-transition-'))
  mkdirSync(join(sourceDir, 'static', 'assets'), { recursive: true })
  mkdirSync(join(sourceDir, 'driver'), { recursive: true })
  writeFileSync(join(sourceDir, 'static', 'index.html'), '<html><head><script src="/original.js"></script></head><body></body></html>')
  writeFileSync(join(sourceDir, 'static', 'assets', 'index.a75a6e55.js'), wrssPinBundle)
  writeFileSync(join(sourceDir, 'static', 'assets', 'WechatStatus.62cf3d3b.js'), wrssPinWechatStatus)
  writeFileSync(join(sourceDir, 'driver', 'wx.py'), wrssPinPython)
  writeFileSync(join(sourceDir, 'driver', 'success.py'), wrssPinSuccess)
  ensureWrssStaticAssets(sourceDir)
  const index = readFileSync(join(sourceDir, 'static', 'index.html'), 'utf8')
  const script = readFileSync(join(sourceDir, 'static', 'pussycat-ui.js'), 'utf8')
  expect(index.indexOf('pussycat-critical-theme')).toBeLessThan(index.indexOf('/original.js'))
  const dom = new JSDOM(`<div id="main"><header class="arco-layout-header"><div class="arco-menu"><button class="arco-menu-item" data-route="/">订阅管理</button><button class="arco-menu-item" data-route="/export/records">导出记录</button><button class="arco-menu-item" data-route="/wechat-status">授权管理</button></div></header><section class="arco-layout"><main class="arco-layout"><section class="app-content arco-layout-content"><div class="route-root">文章页</div></section></main></section></div>`, { url: 'http://127.0.0.1:43202/', pretendToBeVisual: true, runScripts: 'outside-only' })
  const { window } = dom
  const animated = []
  const finish = []
  window.Motion = { animate: vi.fn((node, frames) => {
    let resolve
    const finished = new Promise((done) => { resolve = done })
    animated.push({ node, frames })
    finish.push(resolve)
    return { finished, stop: vi.fn(resolve) }
  }) }
  const articleItem = window.document.querySelector('[data-route="/"]')
  const exportItem = window.document.querySelector('[data-route="/export/records"]')
  const wechatItem = window.document.querySelector('[data-route="/wechat-status"]')
  articleItem.addEventListener('click', () => {
    window.history.pushState({}, '', '/')
    window.setTimeout(() => { window.document.querySelector('.app-content').innerHTML = '<div class="route-root">文章页</div>' }, 10)
  })
  exportItem.addEventListener('click', () => {
    window.history.pushState({}, '', '/export/records')
    window.setTimeout(() => { window.document.querySelector('.app-content').innerHTML = '<div class="route-root">导出页</div>' }, 10)
  })
  try {
    window.eval(script)
    await vi.waitFor(() => expect(exportItem.dataset.pussycatPath).toBe('/export/records'))
    exportItem.click()
    articleItem.click()
    await vi.waitFor(() => expect(animated).toHaveLength(1))
    finish[0]()
    await vi.waitFor(() => expect(animated).toHaveLength(2))
    expect(animated[0].node.textContent).toBe('文章页')
    expect(animated[1].node.textContent).toBe('导出页')
    finish[1]()
    await vi.waitFor(() => expect(animated).toHaveLength(3))
    expect(animated[2].frames.transform[1]).toContain('translate3d(8%')
    finish[2]()
    await vi.waitFor(() => expect(animated).toHaveLength(4))
    expect(animated[3].frames.transform[0]).toContain('translate3d(-8%')
    finish[3]()
    await vi.waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(animated.every(({ node }) => node.classList.contains('route-root'))).toBe(true)

    wechatItem.click()
    exportItem.click()
    await vi.waitFor(() => expect(animated).toHaveLength(5))
    window.__PUSSYCAT_WRSS_UI__.destroy()
    finish[4]()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(animated).toHaveLength(5)
    expect(window.location.pathname).toBe('/')
  } finally {
    window.__PUSSYCAT_WRSS_UI__?.destroy()
    window.close()
  }
})

it('uses shared authorization state for status actions and menu logout errors', async () => {
  sourceDir = await mkdtemp(join(tmpdir(), 'wrss-navigation-auth-'))
  mkdirSync(join(sourceDir, 'static', 'assets'), { recursive: true })
  mkdirSync(join(sourceDir, 'driver'), { recursive: true })
  writeFileSync(join(sourceDir, 'static', 'index.html'), '<html><head></head><body></body></html>')
  writeFileSync(join(sourceDir, 'static', 'assets', 'index.a75a6e55.js'), wrssPinBundle)
  writeFileSync(join(sourceDir, 'static', 'assets', 'WechatStatus.62cf3d3b.js'), wrssPinWechatStatus)
  writeFileSync(join(sourceDir, 'driver', 'wx.py'), wrssPinPython)
  writeFileSync(join(sourceDir, 'driver', 'success.py'), wrssPinSuccess)
  ensureWrssStaticAssets(sourceDir)

  const script = readFileSync(join(sourceDir, 'static', 'pussycat-ui.js'), 'utf8')
  const css = readFileSync(join(sourceDir, 'static', 'pussycat-theme.css'), 'utf8')
  const dom = new JSDOM(`<style>${css}</style><div id="main"><header class="arco-layout-header"><div class="arco-menu"><button class="arco-menu-item" data-route="/wechat-status">授权管理</button></div></header><section class="wechat-status-page"><header class="arco-page-header"><h1 class="arco-page-header-title">公众号状态</h1></header><button id="status-scan">扫码授权</button><section class="action-card"><button id="action-scan">扫码授权</button><button>切换账号</button><button>刷新Token</button></section></section></div>`, {
    url: 'http://127.0.0.1:43202/wechat-status', pretendToBeVisual: true, runScripts: 'outside-only',
  })
  const { window } = dom
  const { document } = window
  let rejectLogout
  const logout = vi.fn(() => new Promise((resolve, reject) => { rejectLogout = reject }))
  const prefetch = vi.fn().mockResolvedValue({ code: '/qr' })
  let login = true
  window.__PUSSYCAT_WRSS_AUTH__ = { getState: () => ({ login }), prefetch, logout }
  try {
    window.eval(script)
    await vi.waitFor(() => expect(document.querySelector('.pussycat-wechat-logout')).not.toBeNull())
    expect(window.getComputedStyle(document.querySelector('.action-card')).display).toBe('none')
    expect(window.getComputedStyle(document.getElementById('status-scan')).display).toBe('none')
    expect(prefetch).not.toHaveBeenCalled()
    expect([...document.querySelectorAll('.pussycat-menu-group')].map((node) => node.textContent)).toContain('账户')

    const logoutButton = document.querySelector('.pussycat-wechat-logout')
    logoutButton.click()
    expect(logoutButton.disabled).toBe(true)
    rejectLogout(new Error('退出服务暂时不可用'))
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('退出服务暂时不可用'))
    expect(logoutButton.disabled).toBe(false)
    expect(login).toBe(true)

    login = false
    window.dispatchEvent(new window.CustomEvent('pussycat-wechat-auth-change', { detail: { login: false, info: null } }))
    await vi.waitFor(() => expect(window.getComputedStyle(document.querySelector('.action-card')).display).not.toBe('none'))
    expect(document.querySelector('.pussycat-wechat-logout')).toBeNull()
    expect(window.getComputedStyle(document.getElementById('status-scan')).display).not.toBe('none')
    expect(prefetch).toHaveBeenCalledTimes(1)
    document.querySelector('.wechat-status-page').append(document.createElement('span'))
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    expect(prefetch).toHaveBeenCalledTimes(1)
  } finally {
    window.__PUSSYCAT_WRSS_UI__?.destroy()
    window.close()
  }
})

it('waits for a known unauthorized state before prefetching the WeChat QR code', async () => {
  sourceDir = await mkdtemp(join(tmpdir(), 'wrss-navigation-auth-pending-'))
  mkdirSync(join(sourceDir, 'static', 'assets'), { recursive: true })
  mkdirSync(join(sourceDir, 'driver'), { recursive: true })
  writeFileSync(join(sourceDir, 'static', 'index.html'), '<html><head></head><body></body></html>')
  writeFileSync(join(sourceDir, 'static', 'assets', 'index.a75a6e55.js'), wrssPinBundle)
  writeFileSync(join(sourceDir, 'static', 'assets', 'WechatStatus.62cf3d3b.js'), wrssPinWechatStatus)
  writeFileSync(join(sourceDir, 'driver', 'wx.py'), wrssPinPython)
  writeFileSync(join(sourceDir, 'driver', 'success.py'), wrssPinSuccess)
  ensureWrssStaticAssets(sourceDir)

  const script = readFileSync(join(sourceDir, 'static', 'pussycat-ui.js'), 'utf8')
  const dom = new JSDOM('<div id="main"><section class="wechat-status-page"></section></div>', {
    url: 'http://127.0.0.1:43202/wechat-status', pretendToBeVisual: true, runScripts: 'outside-only',
  })
  let login = null
  const prefetch = vi.fn().mockResolvedValue({ code: '/qr' })
  dom.window.__PUSSYCAT_WRSS_AUTH__ = { getState: () => ({ login }), prefetch }
  try {
    dom.window.eval(script)
    await new Promise((resolve) => dom.window.requestAnimationFrame(resolve))
    expect(prefetch).not.toHaveBeenCalled()
    login = false
    dom.window.dispatchEvent(new dom.window.CustomEvent('pussycat-wechat-auth-change', { detail: { login: false, info: null } }))
    await vi.waitFor(() => expect(prefetch).toHaveBeenCalledTimes(1))
  } finally {
    dom.window.__PUSSYCAT_WRSS_UI__?.destroy()
    dom.window.close()
  }
})
