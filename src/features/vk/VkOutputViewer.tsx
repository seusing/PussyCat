import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useDragControls, useMotionValue } from 'motion/react'
import { BookmarkPlus, Check, Copy, Download } from 'lucide-react'
import Markdown from 'react-markdown'
import { fetchVkJob, fetchVkOutputText } from '../../host/vkClient'
import { HostRequestError } from '../../host/errors'
import { copyText } from '../../lib/clipboard'
import { saveTextFileAs } from '../../lib/saveTextFile'
import { addInspirationItem } from '../inspiration/inspirationLibrary'
import { vkPrimaryOutput, vkResultVersionLabel, type VkResultVersion } from './taskResults'
import './VkOutputViewer.css'

export type VkOutputTab = { id: string; label: string; source?: string; jobId?: string; outputId?: string; versions?: VkResultVersion[] }
type LoadedOutput = { outputId: string; content: string }
export type VkOutputCache = Map<string, LoadedOutput>

function outputFileName(outputId: string): string {
  const name = outputId.split(/[\\/]/).filter(Boolean).at(-1)
  return name || '视频解析结果.md'
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof HostRequestError) return error.reasonCode ? `${error.summary}(${error.reasonCode})` : error.summary
  return error instanceof Error ? error.message || fallback : fallback
}

export function VkOutputViewer({ tabs, activeTabId, onSelectTab, onSelectVersion, baseUrl, onClose, cache }: {
  tabs: VkOutputTab[]
  activeTabId: string
  onSelectTab: (id: string) => void
  onSelectVersion?: (tabId: string, jobId: string) => void
  baseUrl: string
  onClose: () => void
  cache?: VkOutputCache
}) {
  const localCache = useRef<VkOutputCache>(new Map())
  const resultCache = cache ?? localCache.current
  const [loadedState, setLoadedState] = useState<{ key: string; value: LoadedOutput } | null>(null)
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [outputCopied, setOutputCopied] = useState(false)
  const [outputDownloadProgress, setOutputDownloadProgress] = useState<number | null>(null)
  const [outputDownloadDone, setOutputDownloadDone] = useState(false)
  const [outputDownloadHovered, setOutputDownloadHovered] = useState(false)
  const [librarySaved, setLibrarySaved] = useState(false)
  const outputDownloadController = useRef<AbortController | null>(null)
  const outputDownloadResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const interactionGeneration = useRef(0)
  const sectionRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const domId = useId()
  const verticalTabs = tabs.length > 15
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const outputKey = JSON.stringify([baseUrl, activeTabId, activeTab?.jobId, activeTab?.outputId])
  const requestKey = JSON.stringify([baseUrl, activeTab?.outputId ? 'output' : 'job', activeTab?.outputId ?? activeTab?.jobId])
  const loaded = resultCache.get(requestKey)
    ?? (loadedState?.key === outputKey ? loadedState.value : undefined)
  const error = loadError?.key === outputKey ? loadError.message : null
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
    if (verticalTabs) {
      tablist.scrollLeft = 0
      const top = listBounds.top + tablist.clientTop
      const bottom = top + tablist.clientHeight
      if (tabBounds.top < top) tablist.scrollTop += tabBounds.top - top
      else if (tabBounds.bottom > bottom) tablist.scrollTop += tabBounds.bottom - bottom
    } else {
      tablist.scrollTop = 0
      const left = listBounds.left + tablist.clientLeft
      const right = left + tablist.clientWidth
      if (tabBounds.left < left) tablist.scrollLeft += tabBounds.left - left
      else if (tabBounds.right > right) tablist.scrollLeft += tabBounds.right - right
    }
  }, [activeTabId, tabs.length, verticalTabs, size.width, size.height, viewport.width, viewport.height])

  useEffect(() => { sectionRef.current?.focus() }, [])

  useEffect(() => {
    if (!activeTab || resultCache.has(requestKey)) return
    let current = true
    setLoadError(null)
    void (async () => {
      try {
        let outputId = activeTab.outputId
        if (!outputId && activeTab.jobId) {
          const job = await fetchVkJob(activeTab.jobId, baseUrl)
          outputId = vkPrimaryOutput(job)?.id
        }
        if (!outputId) throw new Error('任务尚未生成可用结果')
        const resolvedOutputKey = JSON.stringify([baseUrl, 'output', outputId])
        const value = resultCache.get(resolvedOutputKey) ?? { outputId, content: await fetchVkOutputText(outputId, baseUrl) }
        if (!current) return
        resultCache.set(requestKey, value)
        resultCache.set(resolvedOutputKey, value)
        setLoadedState({ key: outputKey, value })
      } catch (error) {
        if (current) setLoadError({ key: outputKey, message: errorText(error, '结果读取失败') })
      }
    })()
    return () => { current = false }
  }, [outputKey, requestKey, resultCache, activeTab?.id, activeTab?.jobId, activeTab?.outputId, baseUrl, retry])

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
    if (contentRef.current) contentRef.current.scrollTop = 0
    setOutputCopied(false)
    setLibrarySaved(false)
    setActionError(null)
    resetOutputDownload()
    return () => {
      interactionGeneration.current += 1
      outputDownloadController.current?.abort()
      if (outputDownloadResetTimer.current) clearTimeout(outputDownloadResetTimer.current)
    }
  }, [outputKey, resetOutputDownload])

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

  const saveToInspirationLibrary = () => {
    if (!loaded) return
    const saved = addInspirationItem({
      title: activeTab?.label || '视频解析结果',
      content: loaded.content,
      kind: 'video',
      format: 'md',
      folderId: null,
      source: activeTab?.source,
    })
    if (saved) setLibrarySaved(true)
    else setActionError('保存到灵感库失败')
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
          <button type="button" data-testid="vk-output-viewer-save-library" aria-label={librarySaved ? '已收进灵感库' : '收进灵感库'} title={librarySaved ? '已收进灵感库' : '收进灵感库'} disabled={!loaded} onClick={saveToInspirationLibrary} className="vk-output-library-button">
            <BookmarkPlus size={14} aria-hidden="true" /><span>{librarySaved ? '已收进' : '收进灵感库'}</span>
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
        {onSelectVersion && activeTab?.versions && activeTab.versions.length > 1 && (
          <label className="vk-output-version-bar">
            <span>结果版本</span>
            <select aria-label="选择结果版本" value={activeTab.jobId}
              onChange={(event) => onSelectVersion(activeTab.id, event.target.value)}>
              {activeTab.versions.map((version, index) => (
                <option key={version.jobId} value={version.jobId}>{vkResultVersionLabel(version, index === 0)}</option>
              ))}
            </select>
          </label>
        )}
        <div className={`vk-output-body${verticalTabs ? ' is-vertical' : ''}`}>
          <div role="tablist" aria-label="任务结果" aria-orientation={verticalTabs ? 'vertical' : 'horizontal'} className="vk-output-tabs">
            {tabs.map((tab, index) => (
              <button key={tab.id} id={`${domId}-tab-${index}`} role="tab" aria-selected={tab.id === activeTabId}
                aria-controls={`${domId}-panel`} tabIndex={tab.id === activeTabId ? 0 : -1}
                ref={(element) => { if (element) tabRefs.current.set(tab.id, element); else tabRefs.current.delete(tab.id) }}
                title={tab.source || tab.label} onClick={() => onSelectTab(tab.id)}
                onKeyDown={(event) => {
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                    : event.key === (verticalTabs ? 'ArrowDown' : 'ArrowRight') ? (index + 1) % tabs.length
                      : event.key === (verticalTabs ? 'ArrowUp' : 'ArrowLeft') ? (index - 1 + tabs.length) % tabs.length : null
                  if (next === null) return
                  event.preventDefault()
                  onSelectTab(tabs[next].id)
                  tabRefs.current.get(tabs[next].id)?.focus({ preventScroll: true })
                }}
              >{tab.label}</button>
            ))}
          </div>
          <div ref={contentRef} id={`${domId}-panel`} role="tabpanel" aria-labelledby={`${domId}-tab-${tabs.findIndex((tab) => tab.id === activeTabId)}`}
            data-testid="vk-output-viewer-content" className="vk-output-viewer-content" aria-busy={!loaded && !error}>
            {actionError && <p role="alert">{actionError}</p>}
            {error ? <div role="alert">{error}<button type="button" onClick={() => setRetry((value) => value + 1)}>重试</button></div>
              : loaded ? <Markdown>{loaded.content}</Markdown> : <p role="status">正在读取结果…</p>}
          </div>
        </div>
        <span className="vk-output-resize-hint" aria-hidden="true">◢</span>
      </motion.section>
    </div>
  )
}
