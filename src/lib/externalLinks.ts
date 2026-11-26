import { openUrl } from '@tauri-apps/plugin-opener'

// 爪爪窗口(Tauri / WebView2)里,<a target="_blank"> 既不会开新窗口也不会交给系统浏览器,点了没反应;
// 不带 target 的外部链接则会把整个应用窗口跳走。所以在桌面壳里统一接管:点到外站的 http(s) 链接,
// 交给系统默认浏览器打开。浏览器里的开发预览照常走 <a> 自己的行为。

type Opener = (url: string) => Promise<void>

export function isDesktopShell(target: Window = window): boolean {
  return '__TAURI_INTERNALS__' in target
}

/** 这个链接要不要交给系统浏览器:外站的 http(s) 地址才要。 */
export function externalHref(href: string | null, origin: string): string | null {
  if (!href) return null
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.origin === origin ? null : url.toString()
}

export function installExternalLinkHandler(
  doc: Document = document,
  { open = openUrl as Opener, enabled = isDesktopShell() }: { open?: Opener; enabled?: boolean } = {},
): () => void {
  if (!enabled) return () => {}
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    const url = externalHref(anchor?.getAttribute('href') ?? null, doc.location?.origin ?? window.location.origin)
    if (!url) return
    event.preventDefault()
    void open(url).catch((error: unknown) => console.warn('[external-link] open failed', error))
  }
  doc.addEventListener('click', onClick)
  return () => doc.removeEventListener('click', onClick)
}
