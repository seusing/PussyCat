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
// 修复之后自己盯着看的窗口。修复阶梯的最后一级是「拉起浏览器」,而 Host 明确**不在那之后
// 立刻复检** —— Chrome 冷启动加扩展握手远超一次探测的等待窗口,立刻复检只会稳定地把一次
// 可能成功的修复报成失败(理由写在 server/browser-bridge-repair.mjs)。原设计把这一探交给
// 「用户切回窗口」的 focus 事件,但那条路有两个洞:① 浏览器在别的显示器或后台起来,用户
// 根本没离开爪爪,focus 事件永远不来;② 就算切回来,也可能正好落在上面那个 3s 去抖窗口里
// 被吃掉。两种情况下用户都得再手点一次才看见真实状态 —— 而机器此刻完全有能力自己看。
const REPAIR_POLL_INTERVAL_MS = 1500
const REPAIR_POLL_WINDOW_MS = 20_000

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
  if (vk === undefined || !['ok', 'ready', 'running', 'not-configured', 'stopped', 'starting'].includes(vk)) {
    return { tone: 'warn', label: '视频解析状态未知', canRepair: false }
  }
  return { tone: 'ok', label: '基础连接正常', canRepair: false }
}

const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--color-success)',
  checking: 'var(--color-fg-dim)',
  warn: 'var(--color-warning)',
  down: 'var(--color-danger)',
}

// HOST_TEXT / vkLabel 随浮层里那三行明细一并删除:结论已经由 aggregate() 聚合进灯的标签,
// 逐路复述属于开发者排障信息,不再渲染。判定逻辑本身没动,仍在 aggregate() 里。

/** 系统总健康 —— 一颗灯 + 一个能真动手的按钮,取代原先并排的两颗胶囊。 */
export function SystemHealthPill({ baseUrl }: { baseUrl?: string } = {}) {
  const mode = useAppStore((s) => s.mode)
  const demo = mode === 'demo'
  const base = baseUrl ?? DEFAULT_BASE_URL
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [lastCheckedAt, setLastCheckedAt] = useState<number | undefined>()
  const rootRef = useRef<HTMLDivElement>(null)

  // 点别处就收起。浮层压在页面上方,不收起就会挡住它下面的东西 —— 而"再点一次那颗灯"
  // 并不是人的第一反应。用 pointerdown 而不是 click:点下去就收,不必等抬手。
  useEffect(() => {
    if (!detailsOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setDetailsOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetailsOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [detailsOpen])

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
        .then((res) => {
          if (gen !== hostGenRef.current) return
          setHost(res.ok ? 'online' : 'offline')
          setLastCheckedAt(Date.now())
        })
        .catch(() => {
          if (gen !== hostGenRef.current) return
          setHost('offline')
          setLastCheckedAt(Date.now())
        })   // 超时 abort 也判离线
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
        setLastCheckedAt(body.checkedAt || Date.now())
      })
      .catch(() => {
        // 探测本身失败(Host 不可达/超时)与「Host 说桥接没就绪」是两回事:
        // 后者有结构化 reasonCode,前者只知道问不到。分开显示,不伪造一个 health。
        if (gen !== bridgeGenRef.current) return
        setBridge(undefined)
        setBridgeState('failed')
        setLastCheckedAt(Date.now())
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
      .finally(() => setLastCheckedAt(Date.now()))
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

  // 修复后的自盯轮询(理由见 REPAIR_POLL_* 常量处)。一就绪立刻停,超窗也停。
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const stopPolling = useCallback(() => {
    if (pollRef.current !== undefined) { clearInterval(pollRef.current); pollRef.current = undefined }
  }, [])
  useEffect(() => stopPolling, [stopPolling])

  const pollUntilReady = useCallback(() => {
    stopPolling()
    const deadline = Date.now() + REPAIR_POLL_WINDOW_MS
    pollRef.current = setInterval(() => {
      if (Date.now() > deadline) { stopPolling(); return }
      fetch(`${base}/browser-bridge/health`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((body: BridgeHealth) => {
          setBridge(body)
          setBridgeState('idle')
          setLastCheckedAt(body.checkedAt || Date.now())
          lastCheckRef.current = Date.now()
          if (body.reasonCode === 'ok') {
            stopPolling()
            setNextStep(undefined)
            setDetailsOpen(false)   // 和「修好了自动收起」同一条规则:事办完了就别占屏幕
          }
        })
        .catch(() => {})   // 轮询期间的单次失败不改判:窗口内还会再探
    }, REPAIR_POLL_INTERVAL_MS)
  }, [base, stopPolling])

  const repair = useCallback(() => {
    if (mode !== 'connected') return
    stopPolling()
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
        // 修好了就自动收起:事办完了,浮层没有理由继续占着屏幕。没修好则留着 ——
        // nextStep 就写在里面,那正是用户接下来要读的东西。
        if (body.health?.reasonCode === 'ok') setDetailsOpen(false)
        // 还没就绪 ≠ 没修好:拉起浏览器那一级本来就要等 Chrome 冷启动 + 扩展握手。
        // 接着自己盯,不再要求用户手点第二次。
        else pollUntilReady()
      })
      .catch(() => { setNextStep('修复请求没送到。确认爪爪服务在运行后重试') })
      .finally(() => { clearTimeout(timer); setRepairing(false); checkVk() })
  }, [mode, base, checkVk, pollUntilReady, stopPolling])

  const verdict = aggregate({ demo, host, bridge, bridgeState, vk })
  const showRepair = !demo && verdict.canRepair
  const recheck = useCallback(() => { checkBridge(); checkVk() }, [checkBridge, checkVk])

  return (
    <div
      ref={rootRef}
      data-testid="health-pill"
      role="status"
      aria-live="polite"
      className="relative inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm"
      style={{ background: 'var(--color-panel)', color: TONE_COLOR[verdict.tone] }}
      title={nextStep ?? verdict.label}
      // 悬浮即展开、移开即收起。原先要点一下才开、再点一下才关 —— 想瞄一眼状态要花掉两次
      // 点击。事件挂在**根节点**上(它同时包住结论与浮层),所以鼠标从结论滑进浮层里的
      // 「修复」按钮不会算作移开。
      onMouseEnter={() => setDetailsOpen(true)}
      onMouseLeave={() => setDetailsOpen(false)}
      // 键盘同权:只认 hover 会把键盘用户挡在外面。focus 进来就开,焦点离开整块才关。
      onFocus={() => setDetailsOpen(true)}
      onBlur={(event) => {
        // 只在焦点**确实落到了这块之外的某个元素**时才收起。relatedTarget 为 null 表示
        // 焦点没有明确去处(点了浮层标题这类不可聚焦区域,或点到空白),那不算离开 ——
        // 按 null 收起会让"点一下浮层里的文字"把浮层关掉,而里面还有按钮要点。
        const next = event.relatedTarget as Node | null
        if (next && !rootRef.current?.contains(next)) setDetailsOpen(false)
      }}
    >
      <button
        type="button"
        data-testid="health-details-toggle"
        aria-expanded={detailsOpen}
        aria-label="查看连接状态详情"
        // 保留点击:触屏没有 hover,而且点一下就开比"悬停等一会儿"更确定。
        // 这里只开不关 —— 收起交给移开/Esc/点别处,免得"悬停已开着,点一下反而关了"。
        onClick={() => setDetailsOpen(true)}
        className="inline-flex items-center gap-2 px-1 text-left"
        style={{ color: 'inherit' }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 8, background: 'currentColor' }} />
        <span data-testid="health-label">{repairing ? '修复中…' : verdict.label}</span>
      </button>

      {/* 刷新键提到结论旁边。原先它在浮层里,想手动刷一次要先把浮层叫出来再点 —— 两步。
          放这儿是一步,而且不必先知道"详情里有个按钮"。 */}
      {!demo && (
        <button
          type="button"
          data-testid="health-refresh"
          onClick={recheck}
          disabled={repairing}
          aria-label="重新检查状态"
          title="重新检查状态"
          className="rounded px-1 text-xs leading-none disabled:opacity-40"
          style={{ color: 'var(--color-fg-dim)' }}
        >
          ↻
        </button>
      )}

      {/* 外面这层是「桥」,不可见,只负责把胶囊与卡片之间那 8px 缝盖住。
          缝原先是卡片自己的 mt-2 撑的,于是那条带上命中的元素是 header —— 鼠标从胶囊
          往下走的一瞬就算离开了根节点,mouseleave 触发、卡片收起,用户永远够不到里面的
          「修复浏览器连接」。DOM 上卡片一直是根节点的后代,问题不在层级,在**命中测试**:
          mouseleave 看的是指针底下压着谁,不是 DOM 谁包着谁。
          改成外层用 pt-2 撑同样的间距:它的盒子从胶囊底边就开始,缝被自己盖住,
          而卡片看上去仍然隔着 8px,视觉一模一样。 */}
      {detailsOpen && (
        <div className="absolute right-0 top-full z-50 pt-2">
        <div
          data-testid="health-details"
          className="w-64 rounded-lg p-3 text-xs shadow-xl"
          style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
        >
          {/* 三路明细(爪爪服务/浏览器连接/视频解析)撤掉:结论已经写在上面那颗灯的标签里,
              浮层再逐路复述一遍,是把同一件事说了两遍。真正只有这里才有、别处看不到的,
              是版本号与检查时刻 —— 留这两条。哪一路坏了、坏在哪个 reasonCode,是开发者
              排障的信息,不该占用户的浮层。 */}
          <div className="mb-2 font-medium">连接状态</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
            <dt style={{ color: 'var(--color-fg-dim)' }}>OpenCLI 版本</dt>
            <dd data-testid="health-version">{bridge?.opencliVersion ?? '未知'}</dd>
            <dt style={{ color: 'var(--color-fg-dim)' }}>最后检查</dt>
            <dd>{lastCheckedAt ? new Date(lastCheckedAt).toLocaleTimeString() : '尚未完成'}</dd>
          </dl>
          {/* nextStep 留着:它不是报错,是「你接下来该做什么」,只在修复没成时出现。 */}
          {nextStep && (
            <div data-testid="health-next-step" className="mt-3" style={{ color: 'var(--color-fg-dim)' }}>
              {nextStep}
            </div>
          )}
          {showRepair && (
            <button
              data-testid="health-repair"
              onClick={repair}
              disabled={repairing}
              title="修复浏览器连接"
              className="mt-3 rounded px-2 py-1 text-xs disabled:opacity-50"
              style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
            >
              修复浏览器连接
            </button>
          )}
        </div>
        </div>
      )}
    </div>
  )
}
