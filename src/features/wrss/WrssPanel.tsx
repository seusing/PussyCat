import { useCallback, useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { fetchVkWrssManagedStatus, postVkWrssEnable, type WrssManagedStatus } from '../../host/vkClient'
import './WrssPanel.css'
import WrssWorkspace from './WrssWorkspace'

const SIZE_LABEL = '约 356 MB（按需下载）'
function errorText(error: unknown) { return error instanceof Error && error.message ? error.message : '公众号运行环境操作失败' }

export default function WrssPanel({ baseUrl, active = true }: { baseUrl?: string; active?: boolean }) {
  const [status, setStatus] = useState<WrssManagedStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const autoEnabled = useRef(false)
  const refresh = useCallback(async () => {
    try { const next = await fetchVkWrssManagedStatus(baseUrl); setStatus(next); setError(null); return next }
    catch (cause) { setError(errorText(cause)); return null }
  }, [baseUrl])
  const enable = useCallback(async () => {
    setError(null)
    try { setStatus(await postVkWrssEnable(baseUrl)) }
    catch (cause) { setError(errorText(cause)); await refresh() }
  }, [baseUrl, refresh])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!status) return
    if (status.state === 'installed' && !autoEnabled.current) { autoEnabled.current = true; void enable() }
    if (status.state !== 'installed') autoEnabled.current = false
  }, [status, enable])
  useEffect(() => {
    if (!status || !['installing', 'starting'].includes(status.state)) return
    const timer = setInterval(() => { void refresh() }, 250)
    return () => clearInterval(timer)
  }, [status, refresh])
  const state = status?.state ?? 'not-available'
  const logs = status?.progress_log ?? []
  const running = state === 'running'
  const preview = status?.version === 'preview'
  const hostUrl = baseUrl ?? 'http://127.0.0.1:43117'
  return <section className="wrss-panel" data-testid="wrss-panel" aria-label="公众号">
    {running ? <WrssWorkspace baseUrl={baseUrl} mode={preview ? 'preview' : 'real'} active={active} /> : <div className="wrss-card">
      <div className="wrss-heading"><div><h2>公众号</h2><p>在爪爪内阅读、整理和订阅微信公众号内容。</p></div></div>
      {error && <div role="alert" className="wrss-error"><strong>Host 未连接</strong><span>{hostUrl}</span><span>{error}</span>{!isTauri()&&<code>npm run dev:preview</code>}<button type="button" onClick={() => { void refresh() }}>重试</button></div>}
      {state === 'not-installed' && <div className="wrss-ready"><p>首次启用会按需下载 WeRSS 运行环境，安装包大小 {SIZE_LABEL}。</p><p id="wrss-action-description-enable" data-testid="wrss-action-description-enable" className="wrss-action-description">下载并启动公众号运行环境，完成后自动打开公众号界面。</p><button type="button" className="wrss-primary" aria-describedby="wrss-action-description-enable" onClick={() => { void enable() }}>启用公众号</button></div>}
      {state === 'failed' && <div className="wrss-failed"><p>{status?.summary ?? '公众号运行环境失败'}</p><p id="wrss-action-description-retry" data-testid="wrss-action-description-retry" className="wrss-action-description">重新启动公众号运行环境，并保留本次失败信息供查看。</p><button type="button" className="wrss-primary" aria-describedby="wrss-action-description-retry" onClick={() => { void enable() }}>重试</button><details className="wrss-details"><summary>设置与诊断</summary><h3>运行日志</h3><div>状态: {state}</div>{status?.reason_code && <div>reason_code: {status.reason_code}</div>}<div className="wrss-log" aria-label="运行日志">{logs.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}</div></details></div>}
      {state === 'not-available' && !error && <p className="wrss-muted">公众号运行环境暂不可用。</p>}
    </div>}
    {!running && ['installing', 'starting'].includes(state) && <div className="wrss-skeleton" data-testid="wrss-skeleton" role="status" aria-label={state === 'installing' ? '正在安装公众号' : '正在启动公众号'}><div className="wrss-skeleton-topbar" /><div className="wrss-skeleton-body"><div className="wrss-skeleton-sidebar">{Array.from({ length: 7 }, (_, i) => <span key={i} />)}</div><div className="wrss-skeleton-content"><span className="wrss-skeleton-title" />{Array.from({ length: 8 }, (_, i) => <span key={i} />)}</div></div></div>}
  </section>
}
