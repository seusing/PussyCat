import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { DEFAULT_BASE_URL } from '../host/nodeBridgeHost'

// Host 投影后的桥接健康结构(server/browser-bridge-health.mjs)。**前端只渲染,不解释**:
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

export type RepairResult = {
  steps: { action: string; outcome: string; detail?: string }[]
  health: BridgeHealth
  repaired: boolean
  alreadyOk?: boolean
  needsProfileChoice?: boolean
  nextStep?: string
}

const PING_INTERVAL_MS = 5000
const PING_TIMEOUT_MS = 2000
const CHECK_TIMEOUT_MS = 4000
const REPAIR_TIMEOUT_MS = 30_000
// 焦点重探的最小间隔。窗口切换时 focus 与 visibilitychange 常常连着各来一发,
// 而这一发要打 daemon —— 去重比"两个事件挑一个"可靠:两者在不同平台/不同切换
// 方式下的触发组合并不一致,挑哪个都会在某条路径上漏掉。
const REFRESH_DEBOUNCE_MS = 3000

type HostState = 'checking' | 'online' | 'offline'
type BridgeState = 'idle' | 'checking' | 'failed'
type Tone = 'ok' | 'checking' | 'warn' | 'down'

const DAEMON_TEXT: Record<BridgeHealth['daemon'], string> = {
  running: '运行中', stopped: '未运行', unreachable: '无响应', error: '异常',
}
const PROFILE_TEXT: Record<BridgeHealth['profile'], string> = {
  ready: '就绪', required: '需指定', disconnected: '已断开', unknown: '未知',
}

/** 桥接那一路的结论文案 —— 措辞与 Host 的 reasonCode 一一对应,不自己发明状态。 */
export function bridgeLabel(state: BridgeState, health: BridgeHealth | undefined): string {
  if (state === 'checking') return '桥接检测中…'
  if (state === 'failed') return '桥接状态未知'
  if (health?.reasonCode === 'ok') return '浏览器已就绪'
  if (health?.extension === 'disconnected') return '浏览器扩展未连接'
  if (health && health.daemon !== 'running') return `浏览器服务${DAEMON_TEXT[health.daemon]}`
  if (health && health.profile !== 'ready') return `浏览器配置${PROFILE_TEXT[health.profile]}`
  if (health?.extension === 'unknown') return '浏览器扩展状态未知'
  return health?.summary ?? '浏览器桥接未就绪'
}

/**
 * 三路合一的总结论。
 *
 * 之前顶栏最右是一颗只代表 Node Host 的绿灯,却因为最大、最右、唯一带圆点而被读成
 * 全局结论 —— 浏览器扩展没连上时它照样绿着。这里按**严重度**取最差的一路:Host 挂了
 * 什么都别谈,其次才是浏览器桥,再次是视频解析。
 *
 * 视频解析的 not-configured / stopped / starting **不算故障**:sidecar 本来就是按需
 * 启动的,把"没在跑"当异常会让这颗灯长期挂黄,黄久了就等于没有灯。
 */
export function aggregate({ demo, host, bridge, bridgeState, vk }: {
  demo: boolean
  host: HostState
  bridge: BridgeHealth | undefined
  bridgeState: BridgeState
  vk: string | undefined
}): { tone: Tone; label: string; canRepair: boolean } {
  if (demo) return { tone: 'warn', label: '演示模式', canRepair: false }
  if (host === 'checking') return { tone: 'checking', label: '检查中…', canRepair: false }
  if (host === 'offline') return { tone: 'down', label: '爪爪服务离线', canRepair: false }
  if (bridgeState === 'checking') return { tone: 'checking', label: '桥接检测中…', canRepair: false }
  if (bridgeState === 'failed' || (bridge && bridge.reasonCode !== 'ok')) {
    return { tone: 'warn', label: bridgeLabel(bridgeState, bridge), canRepair: !!bridge }
  }
  if (vk === 'failed') return { tone: 'warn', label: '视频解析异常', canRepair: false }
  if (vk === undefined) return { tone: 'warn', label: '视频解析状态未知', canRepair: false }
  return { tone: 'ok', label: '基础连接正常', canRepair: false }
}

const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--color-success)',
  checking: 'var(--color-fg-dim)',
  warn: 'var(--color-warning)',
  down: 'var(--color-danger)',
}

/** 系统总健康 —— 一颗灯 + 一个能真动手的按钮,取代原先并排的两颗胶囊。 */
export function SystemHealthPill({ baseUrl }: { baseUrl?: string } = {}) {
  const mode = useAppStore((s) => s.mode)
  const demo = mode === 'demo'
  const base = baseUrl ?? DEFAULT_BASE_URL

  // —— 第一路:Host 自己。三态,首 ping 落定前显「检查中…」,消灭乐观默认的假「已连接」 ——
  const [host, setHost] = useState<HostState>('checking')
  const hostGenRef = useRef(0)
  useEffect(() => {
    if (mode !== 'connected') return
    setHost('checking')
    let inflight: AbortController | undefined
    const ping = () => {
      const gen = ++hostGenRef.current
      inflight?.abort()                    // 上一发未归即作废,防重叠
      const ctrl = new AbortController()
      inflight = ctrl
      const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS)
      fetch(`${base}/health`, { signal: ctrl.signal })
        .then((res) => { if (gen === hostGenRef.current) setHost(res.ok ? 'online' : 'offline') })
        .catch(() => { if (gen === hostGenRef.current) setHost('offline') })   // 超时 abort 也判离线
        .finally(() => clearTimeout(timer))
    }
    ping()
    const id = setInterval(ping, PING_INTERVAL_MS)
    return () => { hostGenRef.current += 1; inflight?.abort(); clearInterval(id) }
  }, [mode, base])

  // —— 第二路:浏览器桥。**不轮询**(这一发要打 daemon,比 /health 重),但也不能只探一次 ——
  const [bridge, setBridge] = useState<BridgeHealth | undefined>()
  const [bridgeState, setBridgeState] = useState<BridgeState>('idle')
  const bridgeGenRef = useRef(0)
  const lastCheckRef = useRef(0)
  const checkBridge = useCallback(() => {
    if (mode !== 'connected') return
    const gen = ++bridgeGenRef.current
    lastCheckRef.current = Date.now()
    setBridgeState('checking')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
    fetch(`${base}/browser-bridge/health`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: BridgeHealth) => {
        if (gen !== bridgeGenRef.current) return
        setBridge(body)
        setBridgeState('idle')
      })
      .catch(() => {
        // 探测本身失败(Host 不可达/超时)与「Host 说桥接没就绪」是两回事:
        // 后者有结构化 reasonCode,前者只知道问不到。分开显示,不伪造一个 health。
        if (gen !== bridgeGenRef.current) return
        setBridge(undefined)
        setBridgeState('failed')
      })
      .finally(() => clearTimeout(timer))
  }, [mode, base])

  // —— 第三路:视频解析 sidecar。同样按需探,不轮询 ——
  const [vk, setVk] = useState<string | undefined>()
  const checkVk = useCallback(() => {
    if (mode !== 'connected') return
    fetch(`${base}/vk/v1/health`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { status?: string }) => setVk(body?.status))
      .catch(() => setVk(undefined))
  }, [mode, base])

  useEffect(() => {
    checkBridge()
    checkVk()
    return () => { bridgeGenRef.current += 1 }
  }, [checkBridge, checkVk])

  // 窗口重获焦点时重探。只在挂载时探一次会留下一个**会骗人的绿灯**:本组件挂在顶栏、
  // 切模块也不卸载,于是整个应用生命周期只探了开机那一刻 —— 开机时浏览器没开就一直红,
  // 开机时是绿的、你后来关掉浏览器它就一直绿。焦点恰好是真实使用节奏的分界。
  useEffect(() => {
    if (mode !== 'connected') return
    const refresh = () => {
      if (document.visibilityState === 'hidden') return
      if (Date.now() - lastCheckRef.current < REFRESH_DEBOUNCE_MS) return
      checkBridge()
      checkVk()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [checkBridge, checkVk, mode])

  // —— 检测并修复 ——
  const [repairing, setRepairing] = useState(false)
  const [nextStep, setNextStep] = useState<string | undefined>()
  const repair = useCallback(() => {
    if (mode !== 'connected') return
    setRepairing(true)
    setNextStep(undefined)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REPAIR_TIMEOUT_MS)
    fetch(`${base}/browser-bridge/repair`, { method: 'POST', signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: RepairResult) => {
        // Host 已经复检过了,直接采信它的 health —— 不再自己发一次,免得两个来源打架。
        setBridge(body.health)
        setBridgeState('idle')
        lastCheckRef.current = Date.now()
        setNextStep(body.nextStep)
      })
      .catch(() => { setNextStep('修复请求没能送达 Host;确认爪爪服务在运行后再试一次。') })
      .finally(() => { clearTimeout(timer); setRepairing(false); checkVk() })
  }, [mode, base, checkVk])

  const verdict = aggregate({ demo, host, bridge, bridgeState, vk })
  const showRepair = !demo && verdict.canRepair
  const showRecheck = !demo && verdict.tone === 'ok'

  return (
    <span
      data-testid="health-pill"
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-lg px-3 py-1 text-sm"
      style={{ background: 'var(--color-panel)', color: TONE_COLOR[verdict.tone] }}
      title={nextStep ?? verdict.label}
    >
      <span style={{ width: 8, height: 8, borderRadius: 8, background: 'currentColor' }} />
      <span data-testid="health-label">{repairing ? '修复中…' : verdict.label}</span>
      {nextStep && (
        <span data-testid="health-next-step" className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          {nextStep}
        </span>
      )}
      {(showRepair || showRecheck) && (
        <button
          data-testid="health-repair"
          onClick={showRepair ? repair : () => { checkBridge(); checkVk() }}
          disabled={repairing}
          title={showRepair ? '修复浏览器连接' : '重新检查本地服务、浏览器桥接和视频解析状态'}
          className="rounded px-2 py-0.5 text-xs disabled:opacity-50"
          style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
        >
          {showRepair ? '修复浏览器连接' : '重新检查状态'}
        </button>
      )}
    </span>
  )
}
