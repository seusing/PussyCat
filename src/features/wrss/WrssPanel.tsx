import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchVkWrssManagedStatus,
  postVkWrssEnable,
  type WrssManagedStatus,
} from '../../host/vkClient'
import './WrssPanel.css'

const SIZE_LABEL = '约 356 MB（按需下载）'

function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message : '公众号运行环境操作失败'
}

function isLoopbackUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

export default function WrssPanel({ baseUrl }: { baseUrl?: string }) {
  const [status, setStatus] = useState<WrssManagedStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedFrameUrl, setLoadedFrameUrl] = useState<string | null>(null)
  const [exitedSkeletonUrl, setExitedSkeletonUrl] = useState<string | null>(null)
  const autoEnabled = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const next = await fetchVkWrssManagedStatus(baseUrl)
      setStatus(next)
      setError(null)
      return next
    } catch (cause) {
      setError(errorText(cause))
      return null
    }
  }, [baseUrl])

  const enable = useCallback(async () => {
    setError(null)
    try {
      const next = await postVkWrssEnable(baseUrl)
      setStatus(next)
    } catch (cause) {
      setError(errorText(cause))
      await refresh()
    }
  }, [baseUrl, refresh])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!status) return
    if (status.state === 'installed' && !autoEnabled.current) {
      autoEnabled.current = true
      void enable()
    }
    if (status.state !== 'installed') autoEnabled.current = false
  }, [status, enable])

  useEffect(() => {
    if (!status || !['installing', 'starting'].includes(status.state)) return
    const timer = setInterval(() => { void refresh() }, 1_000)
    return () => clearInterval(timer)
  }, [status, refresh])

  const state = status?.state ?? 'not-available'
  const logs = status?.progress_log ?? []
  const runningUrl = state === 'running' && isLoopbackUrl(status?.ui_url) ? status.ui_url : null
  const frameReady = !!runningUrl && loadedFrameUrl === runningUrl
  const showSkeleton = !error && (
    !status
    || state === 'installed'
    || state === 'installing'
    || state === 'starting'
    || (!!runningUrl && exitedSkeletonUrl !== runningUrl)
  )

  useEffect(() => {
    if (!frameReady || !runningUrl) return
    const timer = window.setTimeout(() => setExitedSkeletonUrl(runningUrl), 420)
    return () => window.clearTimeout(timer)
  }, [frameReady, runningUrl])

  return (
    <section className="wrss-panel" data-testid="wrss-panel" aria-label="公众号">
      {runningUrl ? (
        <iframe
          className={`wrss-iframe${frameReady ? ' is-ready' : ''}`}
          data-testid="wrss-iframe"
          title="公众号 WeRSS"
          src={runningUrl}
          sandbox="allow-same-origin allow-scripts allow-forms allow-downloads allow-popups"
          onLoad={() => setLoadedFrameUrl(runningUrl)}
        />
      ) : (
        <div className="wrss-card">
          <div className="wrss-heading">
            <div>
              <h2>公众号</h2>
              <p>在爪爪内阅读、整理和订阅微信公众号内容。</p>
            </div>
          </div>

          {error && <div role="alert" className="wrss-error">{error}</div>}

          {state === 'not-installed' && (
            <div className="wrss-ready">
              <p>首次启用会按需下载 WeRSS 运行环境，安装包大小 {SIZE_LABEL}。</p>
              <button type="button" className="wrss-primary" onClick={() => { void enable() }}>启用公众号</button>
            </div>
          )}

          {state === 'failed' && (
            <div className="wrss-failed">
              <p>{status?.summary ?? '公众号运行环境失败'}</p>
              <button type="button" className="wrss-primary" onClick={() => { void enable() }}>重试</button>
              {(logs.length > 0 || !!status?.reason_code) && (
                <details className="wrss-details">
                  <summary>查看技术详情</summary>
                  {status?.reason_code && <div>reason_code: {status.reason_code}</div>}
                  <div className="wrss-log" aria-label="安装技术日志">
                    {logs.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
                  </div>
                </details>
              )}
            </div>
          )}

          {state === 'not-available' && !error && <p className="wrss-muted">公众号运行环境暂不可用。</p>}
        </div>
      )}
      {showSkeleton && (
        <div className={`wrss-skeleton${frameReady ? ' is-revealed' : ''}`} data-testid="wrss-skeleton" role="status" aria-label={
          state === 'installing' ? '正在安装公众号' : state === 'starting' || state === 'installed' ? '正在启动公众号' : '正在准备公众号'
        }>
          <div className="wrss-skeleton-topbar" />
          <div className="wrss-skeleton-body">
            <div className="wrss-skeleton-sidebar">
              {Array.from({ length: 7 }, (_, index) => <span key={index} />)}
            </div>
            <div className="wrss-skeleton-content">
              <span className="wrss-skeleton-title" />
              {Array.from({ length: 8 }, (_, index) => <span key={index} />)}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
