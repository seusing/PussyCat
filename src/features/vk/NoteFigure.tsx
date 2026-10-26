import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import Lightbox from 'yet-another-react-lightbox'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import 'yet-another-react-lightbox/styles.css'
import { fetchVkFigure } from '../../host/vkClient'
import './NoteFigure.css'

/** 笔记里的配图引用:`figures/<12 位十六进制>.jpg`。 */
export const FIGURE_SRC = /^figures\/([0-9a-f]{12})\.jpg$/

const FIGURE_REF = /!\[[^\]]*\]\(figures\/([0-9a-f]{12})\.jpg\)/g

/** 笔记 Markdown 里配图的名字,按出现顺序、去重。 */
export function listNoteFigureNames(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(FIGURE_REF)].map((match) => match[1]))]
}

type Slide = { name: string; url: string; alt: string }

/**
 * 同一篇笔记的配图集合:names 是笔记里的顺序,urls 是已取回的图。
 * 各配图取回后自己登记,灯箱打开时按这份集合翻页;登记簿只在点击时读,不参与渲染。
 */
export type NoteFigureGallery = {
  names: readonly string[]
  urls: Map<string, { url: string; alt: string }>
}

export const NoteFigureGalleryContext = createContext<NoteFigureGallery | null>(null)

/**
 * 灯箱由 yet-another-react-lightbox 渲染,挂在 body 上:结果窗口带 backdrop-filter,
 * 会成为 fixed 后代的包含块,留在窗口里就只能铺满窗口而不是整个屏幕。
 */
function FigureLightbox({ slides, index, onClose }: { slides: readonly Slide[]; index: number; onClose: () => void }) {
  const [current, setCurrent] = useState(index)
  const items = useMemo(() => slides.map(({ url, alt }) => ({ src: url, alt })), [slides])

  useEffect(() => {
    const opener = document.activeElement
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

  return (
    <Lightbox
      open
      close={onClose}
      className="vk-figure-lightbox"
      slides={items}
      index={index}
      plugins={[Zoom]}
      carousel={{ finite: true }}
      zoom={{ scrollToZoom: true, maxZoomPixelRatio: 4 }}
      controller={{ closeOnBackdropClick: true }}
      on={{ view: ({ index: viewed }) => setCurrent(viewed) }}
      labels={{
        Lightbox: items[current]?.alt || '配图',
        Previous: '上一张',
        Next: '下一张',
        Close: '关闭',
        'Zoom in': '放大',
        'Zoom out': '缩小',
        'Photo gallery': '笔记配图',
        Carousel: '图集',
        Slide: '配图',
        '{index} of {total}': '第 {index} 张，共 {total} 张',
      }}
    />
  )
}

/**
 * 一张笔记配图,显示为缩略图,点开进灯箱翻看同一篇笔记的所有配图。
 * Host 要求请求带白名单 Origin,<img src> 不带,所以用 fetch 取回 blob 再显示;
 * 对象 URL 随图片地址变化或卸载释放。
 */
export function NoteFigure({ jobId, baseUrl, name, alt }: {
  jobId: string
  baseUrl?: string
  name: string
  alt: string
}) {
  const key = JSON.stringify([baseUrl, jobId, name])
  const gallery = useContext(NoteFigureGalleryContext)
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null)
  const [lightbox, setLightbox] = useState<{ slides: Slide[]; index: number } | null>(null)
  const close = useCallback(() => setLightbox(null), [])

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
  const url = state?.url ?? null

  useEffect(() => {
    if (!gallery || !url) return undefined
    gallery.urls.set(name, { url, alt })
    return () => { gallery.urls.delete(name) }
  }, [gallery, name, url, alt])

  if (!state) return <span className="vk-figure is-loading">配图加载中…</span>
  if (!url) return <span className="vk-figure is-failed" title={alt || undefined}>配图加载失败</span>

  const openLightbox = () => {
    const slides = (gallery?.names ?? []).flatMap((item) => {
      const entry = gallery?.urls.get(item)
      return entry ? [{ name: item, ...entry }] : []
    })
    const index = slides.findIndex((slide) => slide.name === name)
    setLightbox(index >= 0 ? { slides, index } : { slides: [{ name, url, alt }], index: 0 })
  }

  return (
    <>
      <span
        className="vk-figure"
        role="button"
        tabIndex={0}
        aria-label={`查看大图：${alt || '配图'}`}
        onClick={openLightbox}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          openLightbox()
        }}
      >
        <img src={url} alt={alt} />
        <span className="vk-figure-caption" title={alt || undefined}>{alt}</span>
      </span>
      {lightbox && <FigureLightbox slides={lightbox.slides} index={lightbox.index} onClose={close} />}
    </>
  )
}
