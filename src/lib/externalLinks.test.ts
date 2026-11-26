import { afterEach, describe, expect, it, vi } from 'vitest'
import { externalHref, installExternalLinkHandler } from './externalLinks'

const ORIGIN = window.location.origin

function link(href: string, inner = false) {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.target = '_blank'
  if (inner) anchor.innerHTML = '<span>打开原文</span>'
  else anchor.textContent = '打开原文'
  document.body.append(anchor)
  return anchor
}

function click(target: Element, init: MouseEventInit = {}) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
  target.dispatchEvent(event)
  return event
}

let uninstall = () => {}
afterEach(() => {
  uninstall()
  document.body.innerHTML = ''
})

describe('externalHref', () => {
  it('外站 http(s) 链接才交给系统浏览器', () => {
    expect(externalHref('https://www.xiaohongshu.com/explore/1?xsec_token=AB', ORIGIN)).toBe('https://www.xiaohongshu.com/explore/1?xsec_token=AB')
    expect(externalHref('http://example.com', ORIGIN)).toBe('http://example.com/')
    expect(externalHref(`${ORIGIN}/settings`, ORIGIN)).toBeNull()
    expect(externalHref('/settings', ORIGIN)).toBeNull()
    expect(externalHref('#top', ORIGIN)).toBeNull()
    expect(externalHref('mailto:a@b.c', ORIGIN)).toBeNull()
    expect(externalHref('javascript:void(0)', ORIGIN)).toBeNull()
    expect(externalHref(null, ORIGIN)).toBeNull()
  })
})

describe('installExternalLinkHandler', () => {
  it('桌面壳里点外站链接:拦下默认行为,用系统浏览器打开;点到链接里的子元素也算', () => {
    const open = vi.fn(async () => {})
    uninstall = installExternalLinkHandler(document, { open, enabled: true })
    const anchor = link('https://www.xiaohongshu.com/explore/69bbe9d8000000001a02e786?xsec_token=AB1', true)

    const event = click(anchor.querySelector('span')!)
    expect(event.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledWith('https://www.xiaohongshu.com/explore/69bbe9d8000000001a02e786?xsec_token=AB1')
  })

  it('站内链接、非左键、别处已处理的点击都不接管', () => {
    const open = vi.fn(async () => {})
    uninstall = installExternalLinkHandler(document, { open, enabled: true })

    expect(click(link('/settings')).defaultPrevented).toBe(false)
    click(link('https://example.com'), { button: 1 })
    const handled = link('https://example.com')
    handled.addEventListener('click', (event) => event.preventDefault())
    click(handled)
    expect(open).not.toHaveBeenCalled()
  })

  it('打开失败不抛到页面上', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const open = vi.fn(async () => { throw new Error('denied') })
    uninstall = installExternalLinkHandler(document, { open, enabled: true })
    click(link('https://example.com'))
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    warn.mockRestore()
  })

  it('浏览器预览里不接管,<a> 照常工作', () => {
    const open = vi.fn(async () => {})
    uninstall = installExternalLinkHandler(document, { open, enabled: false })
    expect(click(link('https://example.com')).defaultPrevented).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
