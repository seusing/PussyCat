import { useEffect, useState } from 'react'
import { useAppStore } from '../store/appStore'

const DEFAULT_NODE_HOST_URL = 'http://127.0.0.1:43117'
const PING_INTERVAL_MS = 5000

export function HealthPill() {
  const mode = useAppStore((s) => s.mode)
  const demo = mode === 'demo'
  // 乐观默认 true：connected 模式下先假定在线，ping 明确失败后才降级，
  // 避免"已连接"文案在首帧到第一次 ping 落定之间闪烁成"未连接"。
  const [alive, setAlive] = useState(true)

  useEffect(() => {
    if (mode !== 'connected') return
    let cancelled = false
    setAlive(true)
    const base = (import.meta.env.VITE_NODE_HOST_URL as string | undefined) ?? DEFAULT_NODE_HOST_URL

    const ping = () => {
      fetch(`${base}/health`)
        .then((res) => { if (!cancelled) setAlive(res.ok) })
        .catch(() => { if (!cancelled) setAlive(false) })
    }

    ping()
    const id = setInterval(ping, PING_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [mode])

  const label = demo ? '演示模式' : alive ? '已连接' : 'Host 离线'
  const color = demo ? 'var(--color-warning)' : alive ? 'var(--color-success)' : 'var(--color-danger)'

  return (
    <span
      data-testid="health-pill"
      className="inline-flex items-center gap-2 rounded-lg px-3 py-1 text-sm"
      style={{ background: 'var(--color-panel)', color }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 8, background: 'currentColor' }} />
      {label}
    </span>
  )
}
