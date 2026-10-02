import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { WechatMarkdownImage } from './WechatMarkdownImage'

afterEach(() => vi.unstubAllGlobals())

describe('WechatMarkdownImage', () => {
  it('loads WeChat images through the host proxy as data URLs', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(new Blob(['png']), {
          headers: { 'content-type': 'image/png' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(
      <WechatMarkdownImage
        baseUrl="http://127.0.0.1:5000"
        src="https://mmbiz.qpic.cn/x/640?wx_fmt=png"
        alt="配图"
      />,
    )

    const image = await screen.findByRole('img', { name: '配图' })
    expect(image.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:5000/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fx%2F640%3Fwx_fmt%3Dpng',
      expect.objectContaining({ cache: 'no-store' }),
    )
  })

  it('leaves other images to the browser', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<WechatMarkdownImage src="data:image/png;base64,AA==" alt="本地图" />)

    expect(screen.getByRole('img', { name: '本地图' })).toHaveAttribute('src', 'data:image/png;base64,AA==')
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled())
  })
})
