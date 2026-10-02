import { afterEach, describe, expect, it, vi } from 'vitest'
import { articleImageUrl, loadWechatImage, wechatImageRemote } from './wechatImage'

afterEach(() => vi.unstubAllGlobals())

describe('wechatImage', () => {
  it('resolves WeChat image addresses and ignores everything else', () => {
    const image = 'https://mmbiz.qpic.cn/x/640?wx_fmt=png'
    expect(wechatImageRemote('data:image/svg+xml,placeholder', image)).toBe(image)
    expect(wechatImageRemote(image)).toBe(image)
    expect(wechatImageRemote('https://mmbiz.qlogo.cn/a', 'https://example.com/a.png')).toBe('')
    expect(wechatImageRemote('https://example.com/a.png')).toBe('')
    expect(wechatImageRemote('/static/res/logo/x.png')).toBe('')
    expect(wechatImageRemote(undefined)).toBe('')
  })

  it('builds the proxy address on the host', () => {
    expect(articleImageUrl('http://127.0.0.1:5000/', 'https://mmbiz.qpic.cn/x/640?a=1')).toBe(
      'http://127.0.0.1:5000/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fx%2F640%3Fa%3D1',
    )
    expect(articleImageUrl(undefined, 'https://mmbiz.qpic.cn/x')).toMatch(/^http:\/\/127\.0\.0\.1:43117\/article-image\?url=/)
  })

  it('rejects when the host cannot return the image', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 502 }))))
    await expect(loadWechatImage(undefined, 'https://mmbiz.qpic.cn/x')).rejects.toThrow('文章图片加载失败')
  })
})
