import { createContext, useContext, useEffect, useMemo, useState, type ComponentProps, type KeyboardEvent, type MouseEvent } from 'react'
import type { ExtraProps } from 'react-markdown'
import wenkaiWoff2 from '@fontsource/lxgw-wenkai/files/lxgw-wenkai-latin-500-normal.woff2?url'
import { fetchVkFigure } from '../../host/vkClient'
import { blobToDataUrl } from '../../lib/blobToDataUrl'
import { INLINE_IMAGE_SRC } from '../../lib/noteMarkdown'
import { FIGURE_SRC, NoteFigure, useFigureLightbox } from './NoteFigure'
import { readScreenshotBlock, SCREENSHOT_FENCE, SCREENSHOT_FIGURE_SRC } from './screenshotBlocks'
import './AnnotatedFigure.css'

// 批注手写体(霞鹜文楷)只登记 woff2:包里的 500.css 同时引用 woff2 和 woff,构建会把两份都打进安装包,
// 而 WebView2 只会用 woff2,woff 那份 10MB 纯属白带。包里没有 400 字重,500 最接近。
if (typeof FontFace !== 'undefined' && typeof document !== 'undefined') {
  document.fonts.add(new FontFace('LXGW WenKai', `url(${wenkaiWoff2}) format('woff2')`, { weight: '500', display: 'swap' }))
}

type Rendered = { html: string; dataUrl: string }

// 把块的 src 换成 data URL 再交给渲染器:应用 CSP 的 img-src 不放行 Host 地址,配图只能先取回。
// src 已是 data URL(灵感库里的笔记)就直接用,不再取图。
async function renderBlock(block: string, src: string, jobId: string | undefined, baseUrl: string | undefined): Promise<Rendered> {
  const name = FIGURE_SRC.exec(src)?.[1]
  let dataUrl = src
  let source = block
  if (!INLINE_IMAGE_SRC.test(src)) {
    if (!name || !jobId) throw new Error('无法取回原图')
    dataUrl = await blobToDataUrl(await fetchVkFigure(jobId, name, baseUrl))
    source = block.replace(SCREENSHOT_FIGURE_SRC, (_match, head: string, _name: string, tail: string) => `${head}${dataUrl}${tail}`)
  }
  const { renderAnnotated } = await import('./annotateRender')
  return { html: await renderAnnotated(source), dataUrl }
}

// 取图或渲染失败时退回普通配图,不让整篇笔记出错。
function PlainFigure({ src, alt, jobId, baseUrl }: { src: string; alt: string; jobId?: string; baseUrl?: string }) {
  const name = FIGURE_SRC.exec(src)?.[1]
  if (name && jobId) return <NoteFigure jobId={jobId} baseUrl={baseUrl} name={name} alt={alt} />
  if (INLINE_IMAGE_SRC.test(src)) return <img src={src} alt={alt} />
  return <span className="vk-figure is-failed" title={alt || undefined}>配图加载失败</span>
}

/**
 * 一张带手绘批注的原图:`::screenshot{…}` 块(comark-annotate 语法)渲染成图加批注。
 * 渲染期间按块里的 viewport 预留位置;点图进灯箱(同一篇笔记的配图连着翻页,灯箱里是不带批注的原图)。
 */
export function AnnotatedFigure({ block, jobId, baseUrl }: { block: string; jobId?: string; baseUrl?: string }) {
  const input = useMemo(() => ({ block, jobId, baseUrl }), [block, jobId, baseUrl])
  const { src, alt, viewport } = useMemo(() => readScreenshotBlock(block), [block])
  const [loaded, setLoaded] = useState<{ input: typeof input; rendered: Rendered | null } | null>(null)

  useEffect(() => {
    let current = true
    renderBlock(input.block, src, input.jobId, input.baseUrl).then(
      (rendered) => { if (current) setLoaded({ input, rendered }) },
      () => { if (current) setLoaded({ input, rendered: null }) },
    )
    return () => { current = false }
  }, [input, src])

  // 上一块的结果不能挂到换了内容的这块上。
  const state = loaded?.input === input ? loaded : null
  const { open, lightbox } = useFigureLightbox(FIGURE_SRC.exec(src)?.[1] ?? null, state?.rendered?.dataUrl ?? null, alt)

  if (!state) {
    return (
      <div className="vk-annotated-placeholder" style={viewport ? { aspectRatio: `${viewport.width} / ${viewport.height}` } : undefined}>
        配图加载中…
      </div>
    )
  }
  if (!state.rendered) return <PlainFigure src={src} alt={alt} jobId={jobId} baseUrl={baseUrl} />

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('.ca-frame')) open()
  }
  // comark-annotate 把图所在的 .ca-stage 标成可聚焦的缩放目标;原来的缩放脚本被净化掉了,回车或空格改为开灯箱。
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (!(event.target instanceof Element) || !event.target.matches('.ca-stage')) return
    event.preventDefault()
    open()
  }

  return (
    <>
      <div className="vk-annotated dark" onClick={onClick} onKeyDown={onKeyDown} dangerouslySetInnerHTML={{ __html: state.rendered.html }} />
      {lightbox}
    </>
  )
}

export type ScreenshotBlocks = { blocks: readonly string[]; jobId?: string; baseUrl?: string }

/** foldScreenshotBlocks 折叠出的块,以及渲染它们时取图用的任务。 */
export const ScreenshotBlocksContext = createContext<ScreenshotBlocks | null>(null)

/** react-markdown 的 pre 覆盖:折叠留下的占位代码块换回 AnnotatedFigure,其余代码块原样输出。 */
export function ScreenshotCodeBlock({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const context = useContext(ScreenshotBlocksContext)
  const code = node?.children[0]
  if (context && code?.type === 'element' && code.tagName === 'code') {
    const info = code.properties.className
    const first = code.children[0]
    if (Array.isArray(info) && info.includes(`language-${SCREENSHOT_FENCE}`) && first?.type === 'text') {
      const block = context.blocks[Number(first.value)]
      if (block !== undefined) return <AnnotatedFigure block={block} jobId={context.jobId} baseUrl={context.baseUrl} />
    }
  }
  return <pre {...props}>{children}</pre>
}
