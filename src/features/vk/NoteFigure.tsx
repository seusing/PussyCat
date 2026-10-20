import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchVkFigure } from '../../host/vkClient'
import './NoteFigure.css'

/** 笔记里的配图引用:`figures/<12 位十六进制>.jpg`。 */
export const FIGURE_SRC = /^figures\/([0-9a-f]{12})\.jpg$/

/**
 * 灯箱挂到 body:结果窗口带 backdrop-filter,会成为 fixed 后代的包含块,
 * 留在窗口里就只能铺满窗口而不是整个屏幕。
 */
function FigureLightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opener = document.activeElement
    overlayRef.current?.focus({ preventScroll: true })
    // 结果窗口自己监听 Esc 来关整个窗口,灯箱里的 Esc 在 document 捕获阶段先拦下,只关灯箱。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (opener instanceof HTMLElement) opener.focus({ preventScroll: true })
    }
  }, [onClose])

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt || '配图'}
      tabIndex={-1}
      className="vk-figure-lightbox"
      onClick={onClose}
    >
      <img src={url} alt={alt} />
    </div>,
    document.body,
  )
}

/**
 * 一张笔记配图。Host 要求请求带白名单 Origin,<img src> 不带,所以用 fetch 取回 blob 再显示;
 * 对象 URL 随图片地址变化或卸载释放。
 */
export function NoteFigure({ jobId, baseUrl, name, alt }: {
  jobId: string
  baseUrl?: string
  name: string
  alt: string
}) {
  const key = JSON.stringify([baseUrl, jobId, name])
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    let current = true
    let objectUrl: string | null = null
    fetchVkFigure(jobId, name, baseUrl)
      .then((blob) => {
        if (!current) return
        objectUrl = URL.createObjectURL(blob)
        setLoaded({ key, url: objectUrl })
      })
      .catch(() => { if (current) setLoaded({ key, url: null }) })
    return () => {
      current = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [key, jobId, name, baseUrl])

  // 上一张图的结果不能挂到换了地址的这张上。
  const state = loaded?.key === key ? loaded : null
  if (!state) return <span className="vk-figure is-loading">配图加载中…</span>
  if (!state.url) return <span className="vk-figure is-failed" title={alt || undefined}>配图加载失败</span>
  return (
    <>
      <span
        className="vk-figure"
        role="button"
        tabIndex={0}
        aria-label={`查看大图：${alt || '配图'}`}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          setOpen(true)
        }}
      >
        <img src={state.url} alt={alt} />
        <span className="vk-figure-caption">{alt}</span>
      </span>
      {open && <FigureLightbox url={state.url} alt={alt} onClose={close} />}
    </>
  )
}
