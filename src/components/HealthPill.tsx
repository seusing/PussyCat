import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/appStore'

const DEFAULT_NODE_HOST_URL = 'http://127.0.0.1:43117'
const PING_INTERVAL_MS = 5000
const PING_TIMEOUT_MS = 2000

type HealthState = 'checking' | 'online' | 'offline'

export function HealthPill() {
  const mode = useAppStore((s) => s.mode)
  const demo = mode === 'demo'
  // 三态:首 ping 落定前显「检查中…」,消灭乐观默认的假「已连接」窗口(块 C 设计 §3)
  const [state, setState] = useState<HealthState>('checking')
  const genRef = useRef(0)

  useEffect(() => {
    if (mode !== 'connected') return
    setState('checking')
    const base = (import.meta.env.VITE_NODE_HOST_URL as string | undefined) ?? DEFAULT_NODE_HOST_URL
    let inflight: AbortController | undefined

    const ping = () => {
      const gen = ++genRef.current
      inflight?.abort()                    // 上一发未归即作废,防重叠
      const ctrl = new AbortController()
      inflight = ctrl
      const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS)
      fetch(`${base}/health`, { signal: ctrl.signal })
        .then((res) => { if (gen === genRef.current) setState(res.ok ? 'online' : 'offline') })
        .catch(() => { if (gen === genRef.current) setState('offline') })   // 超时 abort 也判离线
        .finally(() => clearTimeout(timer))
    }

    ping()
    const id = setInterval(ping, PING_INTERVAL_MS)
    return () => {
      genRef.current += 1                  // 卸载/切模式:在途响应全部过期
      inflight?.abort()
      clearInterval(id)
    }
  }, [mode])

  const label = demo ? '演示模式' : state === 'checking' ? '检查中…' : state === 'online' ? '已连接' : 'Host 离线'
  const color = demo ? 'var(--color-warning)' : state === 'checking' ? 'var(--color-fg-dim)' : state === 'online' ? 'var(--color-success)' : 'var(--color-danger)'

  return (
    <span
      data-testid="health-pill"
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-lg px-3 py-1 text-sm"
      style={{ background: 'var(--color-panel)', color }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 8, background: 'currentColor' }} />
      {label}
    </span>
  )
}
