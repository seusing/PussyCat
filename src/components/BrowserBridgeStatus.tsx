import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { DEFAULT_BASE_URL } from '../host/nodeBridgeHost'

// Host 投影后的健康结构(server/browser-bridge-health.mjs)。**前端只渲染,不解释**:
// 判定逻辑全在 Host 侧,这里没有第二套「怎样算就绪」的规则。
export type BridgeHealth = {
  checkedAt: number
  daemon: 'running' | 'stopped' | 'unreachable' | 'error'
  daemonVersion?: string
  extension: 'connected' | 'disconnected' | 'unknown'
  extensionVersion?: string
  profile: 'ready' | 'required' | 'disconnected' | 'unknown'
  profileCount: number
  opencliVersion?: string
  retryable: boolean
  reasonCode: string
  summary: string
}

const CHECK_TIMEOUT_MS = 4000

const DAEMON_TEXT: Record<BridgeHealth['daemon'], string> = {
  running: '运行中',
  stopped: '未运行',
  unreachable: '无响应',
  error: '异常',
}
const PROFILE_TEXT: Record<BridgeHealth['profile'], string> = {
  ready: '就绪',
  required: '需指定',
  disconnected: '已断开',
  unknown: '未知',
}

/**
 * 浏览器桥接状态 —— **精简展示,不是设置中心**:检测结果、失败原因、重新检测入口,三样而已。
 *
 * 不自动轮询(对照 HealthPill 的 5s ping):这次探测会打到 daemon,比 /health 重;
 * 而且桥接状态只在用户要跑浏览器命令时才相关。挂载时探一次,之后由用户按「重新检测」。
 */
export function BrowserBridgeStatus({ baseUrl }: { baseUrl?: string } = {}) {
  const mode = useAppStore((s) => s.mode)
  const [health, setHealth] = useState<BridgeHealth | undefined>()
  const [state, setState] = useState<'idle' | 'checking' | 'failed'>('idle')
  const genRef = useRef(0)

  const check = useCallback(() => {
    if (mode !== 'connected') return
    const gen = ++genRef.current
    setState('checking')
    const base = baseUrl ?? DEFAULT_BASE_URL
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
    fetch(`${base}/browser-bridge/health`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: BridgeHealth) => {
        if (gen !== genRef.current) return
        setHealth(body)
        setState('idle')
      })
      .catch(() => {
        // 探测本身失败(Host 不可达/超时)与「Host 说桥接没就绪」是两回事:
        // 后者有结构化 reasonCode,前者只知道问不到。分开显示,不伪造一个 health。
        if (gen !== genRef.current) return
        setHealth(undefined)
        setState('failed')
      })
      .finally(() => clearTimeout(timer))
  }, [mode, baseUrl])

  useEffect(() => {
    check()
    return () => { genRef.current += 1 }
  }, [check])

  if (mode !== 'connected') return null

  const ok = health?.reasonCode === 'ok'
  const color = state === 'checking'
    ? 'var(--color-fg-dim)'
    : ok ? 'var(--color-success)' : 'var(--color-warning)'

  const label = state === 'checking'
    ? '桥接检测中…'
    : state === 'failed'
      ? '桥接状态未知'
      : ok ? '浏览器已就绪'
        : health?.extension === 'disconnected' ? '浏览器扩展未连接'
          : health && health.daemon !== 'running' ? `浏览器服务${DAEMON_TEXT[health.daemon]}`
            : health && health.profile !== 'ready' ? `浏览器配置${PROFILE_TEXT[health.profile]}`
              : health?.extension === 'unknown' ? '浏览器扩展状态未知'
                : (health?.summary ?? '浏览器桥接未就绪')
  const detail = state === 'failed' ? '未能取得诊断结果' : ''

  return (
    <span
      data-testid="browser-bridge-status"
      className="inline-flex items-center gap-2 rounded-lg px-3 py-1 text-xs"
      style={{ background: 'var(--color-panel)', color }}
      title={label}
    >
      <span data-testid="bridge-label">{label}</span>
      <span data-testid="bridge-detail" style={{ color: 'var(--color-fg-dim)' }}>{detail}</span>
      <button
        data-testid="bridge-recheck"
        onClick={check}
        disabled={state === 'checking'}
        className="rounded px-2 py-0.5 disabled:opacity-50"
        style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
      >
        重新检测
      </button>
    </span>
  )
}
