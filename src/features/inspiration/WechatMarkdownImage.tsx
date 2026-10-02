import { useEffect, useState } from 'react'
import { loadWechatImage, wechatImageRemote } from './wechatImage'

// 应用 CSP 只放行 'self' 和 data: 图片,公众号图片必须经宿主代理取回再转成 data URL。
export function WechatMarkdownImage({
  baseUrl,
  src,
  alt,
}: {
  baseUrl?: string
  src?: string
  alt?: string
}) {
  const remote = wechatImageRemote(src)
  const [data, setData] = useState('')
  useEffect(() => {
    setData('')
    if (!remote) return
    const controller = new AbortController()
    loadWechatImage(baseUrl, remote, controller.signal)
      .then(setData)
      .catch(() => {})
    return () => controller.abort()
  }, [baseUrl, remote])
  if (!remote) return src ? <img src={src} alt={alt ?? ''} /> : null
  return data ? <img src={data} alt={alt ?? ''} /> : null
}
