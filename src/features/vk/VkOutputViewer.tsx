import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useDragControls, useMotionValue } from 'motion/react'
import { Check, Copy, Download } from 'lucide-react'
import Markdown from 'react-markdown'
import { fetchVkJob, fetchVkOutputText, type VkJobView } from '../../host/vkClient'
import { HostRequestError } from '../../host/errors'
import { copyText } from '../../lib/clipboard'
import { saveTextFileAs } from '../../lib/saveTextFile'
import './VkOutputViewer.css'

export type VkOutputTab = { id: string; label: string; source?: string; jobId?: string; outputId?: string }
type LoadedOutput = { outputId: string; content: string }

function primaryOutput(job: VkJobView): { id: string; title: string } | null {
  if (job.outputs?.note_path) return { id: job.outputs.note_path, title: '知识笔记' }
  const product = job.outputs?.product_artifacts?.find((artifact) => artifact.markdown)
  if (product?.markdown) return { id: product.markdown, title: `${product.preset} MD` }
  if (job.outputs?.audit_path) return { id: job.outputs.audit_path, title: '证据审计' }
  return null
}

function outputFileName(outputId: string): string {
  const name = outputId.split(/[\\/]/).filter(Boolean).at(-1)
  return name || '视频解析结果.md'
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof HostRequestError) return error.reasonCode ? `${error.summary}(${error.reasonCode})` : error.summary
  return error instanceof Error ? error.message || fallback : fallback
}

export function VkOutputViewer({ tabs, activeTabId, onSelectTab, baseUrl, onClose }: {
  tabs: VkOutputTab[]
  activeTabId: string
  onSelectTab: (id: string) => void
  baseUrl: string
  onClose: () => void
}) {
  const cache = useRef(new Map<string, LoadedOutput>())
  const [loadedState, setLoadedState] = useState<{ tabId: string; value: LoadedOutput } | null>(null)
  const [loadError, setLoadError] = useState<{ tabId: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [outputCopied, setOutputCopied] = useState(false)
  const [outputDownloadProgress, setOutputDownloadProgress] = useState<number | null>(null)
  const [outputDownloadDone, setOutputDownloadDone] = useState(false)
  const [outputDownloadHovered, setOutputDownloadHovered] = useState(false)
  const outputDownloadController = useRef<AbortController | null>(null)
  const outputDownloadResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const interactionGeneration = useRef(0)
  const sectionRef = useRef<HTMLElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const domId = useId()
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const loaded = cache.current.get(activeTabId) ?? (loadedState?.tabId === activeTabId ? loadedState.value : undefined)
  const error = loadError?.tabId === activeTabId ? loadError.message : null
  const dragControls = useDragControls()
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const [size, setSize] = useState(() => ({ width: Math.min(960, window.innerWidth - 24), height: Math.min(700, window.innerHeight - 24) }))
  const initialSize = useRef(size)
  const x = useMotionValue((viewport.width - size.width) / 2)
  const y = useMotionValue((viewport.height - size.height) / 2)
  const constraints = { left: 12, top: 12, right: Math.max(12, viewport.width - size.width - 12), bottom: Math.max(12, viewport.height - size.height - 12) }

  useEffect(() => {
    const updateViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', updateViewport)
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.target.clientWidth + 2, height: entry.target.clientHeight + 2 })
    })
    if (sectionRef.current) observer.observe(sectionRef.current)
    return () => { window.removeEventListener('resize', updateViewport); observer.disconnect() }
  }, [])

  useLayoutEffect(() => {
    x.set(Math.max(12, Math.min(x.get(), constraints.right)))
    y.set(Math.max(12, Math.min(y.get(), constraints.bottom)))
  }, [constraints.right, constraints.bottom, x, y])

  useLayoutEffect(() => {
    const tab = tabRefs.current.get(activeTabId)
    const tablist = tab?.parentElement
    if (!tab || !tablist) return
    const tabBounds = tab.getBoundingClientRect()
    const listBounds = tablist.getBoundingClientRect()
    const left = listBounds.left + tablist.clientLeft
    const right = left + tablist.clientWidth
    if (tabBounds.left < left) tablist.scrollLeft += tabBounds.left - left
    else if (tabBounds.right > right) tablist.scrollLeft += tabBounds.right - right
  }, [activeTabId, tabs.length, size.width, viewport.width])

  useEffect(() => { sectionRef.current?.focus() }, [])

  useEffect(() => {
    if (!activeTab || cache.current.has(activeTab.id)) return
    let current = true
    setLoadError(null)
    void (async () => {
      try {
        let outputId = activeTab.outputId
        if (!outputId && activeTab.jobId) {
          const job = await fetchVkJob(activeTab.jobId, baseUrl)
          outputId = primaryOutput(job)?.id
        }
        if (!outputId) throw new Error('任务尚未生成可用结果')
        const value = { outputId, content: await fetchVkOutputText(outputId, baseUrl) }
        if (!current) return
        cache.current.set(activeTab.id, value)
        setLoadedState({ tabId: activeTab.id, value })
      } catch (error) {
        if (current) setLoadError({ tabId: activeTab.id, message: errorText(error, '结果读取失败') })
      }
    })()
    return () => { current = false }
  }, [activeTab?.id, activeTab?.jobId, activeTab?.outputId, baseUrl, retry])

  const resetOutputDownload = useCallback(() => {
    outputDownloadController.current?.abort()
    outputDownloadController.current = null
    if (outputDownloadResetTimer.current) clearTimeout(outputDownloadResetTimer.current)
    outputDownloadResetTimer.current = null
    setOutputDownloadProgress(null)
    setOutputDownloadDone(false)
    setOutputDownloadHovered(false)
  }, [])

  useLayoutEffect(() => {
    interactionGeneration.current += 1
    setOutputCopied(false)
    setActionError(null)
    resetOutputDownload()
    return () => {
      interactionGeneration.current += 1
      outputDownloadController.current?.abort()
      if (outputDownloadResetTimer.current) clearTimeout(outputDownloadResetTimer.current)
    }
  }, [activeTabId, resetOutputDownload])

  const downloadOutput = useCallback(async () => {
    if (!loaded) return
    if (outputDownloadController.current) {
      resetOutputDownload()
      return
    }

    const controller = new AbortController()
    outputDownloadController.current = controller
    setOutputDownloadDone(false)
    setOutputDownloadProgress(0)
    setActionError(null)
    try {
      const saved = await saveTextFileAs(outputFileName(loaded.outputId), loaded.content, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (outputDownloadController.current === controller) setOutputDownloadProgress(progress)
        },
      })
      if (controller.signal.aborted) return
      setOutputDownloadProgress(null)
      if (saved) {
        setOutputDownloadDone(true)
        outputDownloadResetTimer.current = setTimeout(() => {
          setOutputDownloadDone(false)
          outputDownloadResetTimer.current = null
        }, 1_200)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setActionError(errorText(error, '保存失败'))
        setOutputDownloadProgress(null)
      }
    } finally {
      if (outputDownloadController.current === controller) outputDownloadController.current = null
    }
  }, [loaded, resetOutputDownload])

  const copyOutput = async () => {
    if (!loaded) return
    const generation = interactionGeneration.current
    try {
      const copied = await copyText(loaded.content)
      if (generation !== interactionGeneration.current) return
      if (copied) setOutputCopied(true)
      else setActionError('复制内容失败')
    } catch (error) {
      if (generation === interactionGeneration.current) setActionError(errorText(error, '复制内容失败'))
    }
  }

  return (
    <div data-testid="vk-output-viewer" className="vk-output-viewer">
      <motion.section
        ref={sectionRef}
        role="dialog"
        aria-labelledby={`${domId}-title`}
        tabIndex={-1}
        className="vk-output-window"
        drag dragControls={dragControls} dragListener={false} dragMomentum={false} dragElastic={0}
        dragConstraints={constraints}
        style={{ x, y, width: initialSize.current.width, height: initialSize.current.height }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
      >
        <header className="vk-output-titlebar" onPointerDown={(event) => {
          if (!(event.target as HTMLElement).closest('button, [role="tab"]')) dragControls.start(event)
        }}>
          <h2 id={`${domId}-title`}>解析结果</h2>
          <button type="button" data-testid="vk-output-viewer-copy" aria-label={outputCopied ? '已复制' : '复制内容'} title={outputCopied ? '已复制' : '复制内容'} disabled={!loaded} onClick={() => { void copyOutput() }} className="vk-output-copy-button">
            <Copy size={14} aria-hidden="true" /><span>{outputCopied ? '已复制' : '复制内容'}</span>
          </button>
          <motion.button
            type="button"
            data-testid="vk-output-viewer-download"
            data-state={outputDownloadProgress !== null ? 'downloading' : outputDownloadDone ? 'done' : 'idle'}
            disabled={!loaded}
            onClick={() => { void downloadOutput() }}
            onMouseEnter={() => setOutputDownloadHovered(true)}
            onMouseLeave={() => setOutputDownloadHovered(false)}
            aria-label={outputDownloadProgress !== null ? '取消下载' : '下载至本地'}
            aria-busy={outputDownloadProgress !== null}
            className="vk-output-download-button"
            whileHover={{ scale: 1.02 }}
            transition={{ type: 'spring', stiffness: 600, damping: 25 }}
          >
            {outputDownloadProgress !== null && (
              <span
                data-testid="vk-output-download-progress"
                className="vk-output-download-progress"
                style={{ width: `${outputDownloadProgress}%` }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(outputDownloadProgress)}
              />
            )}
            <span className="vk-output-download-content">
              {outputDownloadProgress !== null ? (
                <span>{Math.round(outputDownloadProgress)}% · 点击取消</span>
              ) : (
                <>
                  <span className="relative flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span
                        key={outputDownloadDone || outputDownloadHovered ? 'check' : 'download'}
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.5, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 600, damping: 25 }}
                        className="absolute inset-0 flex items-center justify-center"
                      >
                        {outputDownloadDone || outputDownloadHovered
                          ? <Check className="h-4 w-4" />
                          : <Download className="h-4 w-4" />}
                      </motion.span>
                    </AnimatePresence>
                  </span>
                  <span>{outputDownloadDone ? '已保存' : '下载至本地'}</span>
                </>
              )}
            </span>
          </motion.button>
          <button type="button" data-testid="vk-output-viewer-close" aria-label="关闭结果" title="关闭" onClick={onClose} className="vk-output-close">×</button>
        </header>
        <div role="tablist" aria-label="任务结果" className="vk-output-tabs">
          {tabs.map((tab, index) => (
            <button key={tab.id} id={`${domId}-tab-${index}`} role="tab" aria-selected={tab.id === activeTabId}
              aria-controls={`${domId}-panel`} tabIndex={tab.id === activeTabId ? 0 : -1}
              ref={(element) => { if (element) tabRefs.current.set(tab.id, element); else tabRefs.current.delete(tab.id) }}
              title={tab.source || tab.label} onClick={() => onSelectTab(tab.id)}
              onKeyDown={(event) => {
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                  : event.key === 'ArrowRight' ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : null
                if (next === null) return
                event.preventDefault()
                onSelectTab(tabs[next].id)
                tabRefs.current.get(tabs[next].id)?.focus()
              }}
            >{tab.label}</button>
          ))}
        </div>
        <div id={`${domId}-panel`} role="tabpanel" aria-labelledby={`${domId}-tab-${tabs.findIndex((tab) => tab.id === activeTabId)}`}
          data-testid="vk-output-viewer-content" className="vk-output-viewer-content" aria-busy={!loaded && !error}>
          {actionError && <p role="alert">{actionError}</p>}
          {error ? <div role="alert">{error}<button type="button" onClick={() => setRetry((value) => value + 1)}>重试</button></div>
            : loaded ? <Markdown>{loaded.content}</Markdown> : <p role="status">正在读取结果…</p>}
        </div>
        <span className="vk-output-resize-hint" aria-hidden="true">◢</span>
      </motion.section>
    </div>
  )
}
