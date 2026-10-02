import { DEFAULT_BASE_URL } from '../../host/nodeBridgeHost'

const WECHAT_IMAGE_HOSTS = ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'mmecoa.qpic.cn']

const isRemote = (value: string) => value.startsWith('http://') || value.startsWith('https://')

export function articleImageUrl(base: string | undefined, url: string) {
  return `${(base || DEFAULT_BASE_URL).replace(/\/$/, '')}/article-image?url=${encodeURIComponent(url)}`
}

// 文章 HTML 里的真实地址在 data-src,src 多是占位图。只认微信自己的图床。
export function wechatImageRemote(src?: string | null, lazy?: string | null) {
  const candidate = isRemote(lazy || '') ? lazy! : isRemote(src || '') ? src! : ''
  if (!candidate) return ''
  try {
    const url = new URL(candidate)
    return WECHAT_IMAGE_HOSTS.includes(url.hostname) ? url.href : ''
  } catch {
    return ''
  }
}

export async function loadWechatImage(base: string | undefined, remote: string, signal?: AbortSignal) {
  const response = await fetch(articleImageUrl(base, remote), { cache: 'no-store', signal })
  if (!response.ok) throw new Error('文章图片加载失败')
  const blob = await response.blob()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
