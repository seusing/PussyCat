import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { siteLabel } from '../../data/zhCopy'
import { isAcknowledged } from '../../data/preferences'
import { stateFromDecision, type LoginCheckState } from '../../data/loginStatus'
import {
  AUTO_REFRESH_MAX_MINUTES, AUTO_REFRESH_MIN_MINUTES, clampIntervalMinutes,
} from '../../data/loginStatus'
import { loadLayout, saveLayout } from '../../data/layout'

const STATE_TEXT: Record<LoginCheckState, string> = {
  unchecked: '未检查',
  queued: '排队中',
  checking: '检查中…',
  'logged-in': '已登录',
  'logged-out': '需重新登录',
  error: '检查失败',
  'needs-ack': '需先确认',
  'not-approved': '未审定',
}

const STATE_COLOR: Record<LoginCheckState, string> = {
  unchecked: 'var(--color-fg-dim)',
  queued: 'var(--color-fg-dim)',
  checking: 'var(--color-fg-dim)',
  'logged-in': 'var(--color-success)',
  'logged-out': 'var(--color-danger)',
  error: 'var(--color-warning)',
  'needs-ack': 'var(--color-warning)',
  'not-approved': 'var(--color-fg-dim)',
}

/** 可检查 = Host 允许执行且用户已确认过。not-approved / needs-ack 都不可直接检查。 */
const CHECKABLE: LoginCheckState[] = ['unchecked', 'logged-in', 'logged-out', 'error']

function relativeTime(at: number | undefined, now: number): string {
  if (!at) return '—'
  const min = Math.floor((now - at) / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  return `${Math.floor(hr / 24)} 天前`
}

export function LoginStatusPanel() {
  const commands = useAppStore((s) => s.commands)
  const decisionFor = useAppStore((s) => s.decisionFor)
  const preferences = useAppStore((s) => s.preferences)
  const loginChecks = useAppStore((s) => s.loginChecks)
  const loginQueue = useAppStore((s) => s.loginQueue)
  const loginInFlights = useAppStore((s) => s.loginInFlights)
  const enqueueLoginChecks = useAppStore((s) => s.enqueueLoginChecks)
  const requestAcknowledgement = useAppStore((s) => s.requestAcknowledgement)
  const selectCommand = useAppStore((s) => s.selectCommand)

  const [auto, setAuto] = useAutoRefresh()
  const [actionGroupOpen, setActionGroupOpen] = useState(true)
  const now = Date.now()

  // 站点清单来自目录里所有 whoami 命令 —— **不维护写死的站点列表**。
  // 哪些能查由 Host 判决说了算(I-P1),这里只负责把判决翻译成一行状态。
  const rows = useMemo(() => {
    return commands
      .filter((c) => c.name === 'whoami')
      .map((c) => {
        const decision = decisionFor(c.command)
        const acked = !!decision?.fingerprint && isAcknowledged(preferences, c.command, decision.fingerprint)
        const derived = stateFromDecision(decision, acked)
        const tracked = loginChecks[c.site]
        // 已经查过的用查过的结果;没查过的用判决推出来的初始态。
        // 但**判决说不可查时以判决为准** —— 策略可能在上次检查之后收紧了。
        const state: LoginCheckState = derived === 'not-approved' || derived === 'needs-ack'
          ? derived
          : (tracked?.state ?? 'unchecked')
        return { site: c.site, commandKey: c.command, command: c, decision, state, entry: tracked }
      })
      .sort((a, b) => {
        // 可检查的排前面 —— 未审定的 61 条不该占据视线
        const rank = (s: LoginCheckState) => (CHECKABLE.includes(s) || s === 'checking' || s === 'queued' ? 0 : s === 'needs-ack' ? 1 : 2)
        return rank(a.state) - rank(b.state) || a.site.localeCompare(b.site)
      })
  }, [commands, decisionFor, preferences, loginChecks])

  const checkable = rows.filter((r) => CHECKABLE.includes(r.state) || r.state === 'checking' || r.state === 'queued')
  const notApproved = rows.filter((r) => r.state === 'not-approved')
  const needsAck = rows.filter((r) => r.state === 'needs-ack')
  const actionRows = rows.filter((r) => r.state !== 'logged-in' && r.state !== 'not-approved')
  const loggedInRows = rows.filter((r) => r.state === 'logged-in')
  const otherRows = rows.filter((r) => r.state === 'not-approved')
  const pending = loginQueue.length + loginInFlights.length
  const queueStatus = loginInFlights.length > 0
    // 并发之后"正在检查"可能有好几个:只报数与剩余,别把一个站点的名字冒充成全部。
    ? loginInFlights.length === 1
      ? `正在检查 ${siteLabel(loginInFlights[0].site)}，剩余 ${loginQueue.length}`
      : `正在检查 ${loginInFlights.length} 个站点，剩余 ${loginQueue.length}`
    : loginQueue.length > 0 ? `队列中 ${loginQueue.length}` : '无待处理检查'
  // **逐行判忙,不再用全局锁。** 之前 busy 一旦为真就把所有刷新按钮一起禁用,
  // 于是点一个站点会让其余全部变灰——那是把"排队执行"错误地表达成了"全局互斥"。
  // 现在最多几个同时在飞,其余仍是排队;各行各自排队、各自显示自己的状态。
  const isRowBusy = (site: string) => loginInFlights.some((x) => x.site === site) || loginQueue.includes(site)

  // 自动刷新:**只在应用运行期生效**,组件卸载即清。绝不写操作系统级定时任务。
  // 只排已确认且判决允许的站点 —— 遇到 needs-ack **跳过而不是弹框**,
  // 后台定时任务弹出确认对话框会打断用户手上的事。
  useEffect(() => {
    if (!auto.enabled) return
    const tick = () => {
      const sites = useAppStore.getState().commands
        .filter((c) => c.name === 'whoami')
        .filter((c) => {
          const d = useAppStore.getState().decisionFor(c.command)
          const acked = !!d?.fingerprint && isAcknowledged(useAppStore.getState().preferences, c.command, d.fingerprint)
          return CHECKABLE.includes(stateFromDecision(d, acked))
        })
        .map((c) => c.site)
      if (sites.length > 0) useAppStore.getState().enqueueLoginChecks(sites)
    }
    const id = setInterval(tick, auto.minutes * 60_000)
    return () => clearInterval(id)
  }, [auto.enabled, auto.minutes])

  const renderRows = (group: typeof rows) => group.map((r) => {
    const rowBusy = isRowBusy(r.site)
    const canCheck = CHECKABLE.includes(r.state) && !rowBusy
    return (
      <div key={r.commandKey} data-testid={`login-row-${r.site}`}
        className="flex flex-wrap items-center gap-3 border-b px-3 py-2 last:border-b-0"
        style={{ borderColor: 'var(--color-line)', opacity: r.state === 'not-approved' ? 0.55 : 1 }}>
        <span className="w-32 shrink-0 truncate text-sm">{siteLabel(r.site)}</span>
        <span data-testid={`login-state-${r.site}`} className="w-24 shrink-0 text-xs"
          style={{ color: STATE_COLOR[r.state] }}>{STATE_TEXT[r.state]}</span>
        <span className="order-last min-w-0 basis-full truncate text-xs sm:order-none sm:basis-auto sm:flex-1" style={{ color: 'var(--color-fg-dim)' }}>
          {r.state === 'not-approved' ? '该站的 whoami 尚未通过安全审定，Host 不会执行' : (r.entry?.detail ?? '')}
        </span>
        <span className="w-20 shrink-0 text-right text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          {relativeTime(r.entry?.checkedAt, now)}
        </span>
        {r.state === 'needs-ack' ? (
          <button data-testid={`login-ack-${r.site}`}
            onClick={() => { selectCommand(r.command); if (r.decision) requestAcknowledgement(r.command, r.decision) }}
            className="shrink-0 rounded px-2 py-1 text-xs"
            style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}>
            确认后可检查
          </button>
        ) : (
          <button data-testid={`login-refresh-${r.site}`} disabled={!canCheck}
            onClick={() => enqueueLoginChecks([r.site])}
            title={rowBusy ? '该站点已在队列中' : canCheck ? '检查该站点；可能唤起或切换浏览器标签页' : '该站点当前不可检查'}
            className="shrink-0 rounded px-2 py-1 text-xs disabled:opacity-40"
            style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}>
            检查
          </button>
        )}
      </div>
    )
  })

  return (
    <div className="mx-auto max-w-3xl p-3 sm:p-6">
      <h2 className="mb-1 text-lg font-semibold">登录状态</h2>
      {/* 一句话。原文三行讲机制(whoami、真发请求、只对审定过的生效),用户不会读,
          读了也不改变他要做什么 —— 他唯一需要知道的是「别把浏览器登录退掉」。
          机制说明没有丢:审定与确认的状态就写在每一行的状态列里,那里才是它该在的位置。 */}
      <p className="mb-4 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
        请持续保持你已登录的浏览器会话
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg p-3"
        style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
        <button
          data-testid="refresh-all-logins"
          disabled={checkable.length === 0}
          onClick={() => enqueueLoginChecks(checkable.map((r) => r.site))}
          title="检查全部登录状态；可能唤起或切换浏览器标签页"
          className="rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
        >
          {pending > 0 ? `检查全部登录状态（排队 ${pending}）` : '检查全部登录状态'}
        </button>

        <label className="flex items-center gap-2 text-sm">
          <input
            data-testid="auto-refresh-toggle"
            type="checkbox"
            checked={auto.enabled}
            onChange={(e) => setAuto({ ...auto, enabled: e.target.checked })}
          />
          定时检查
        </label>
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          每
          <input
            data-testid="auto-refresh-minutes"
            type="number"
            min={AUTO_REFRESH_MIN_MINUTES}
            max={AUTO_REFRESH_MAX_MINUTES}
            value={auto.minutes}
            onChange={(e) => setAuto({ ...auto, minutes: clampIntervalMinutes(Number(e.target.value)) })}
            className="w-16 rounded px-2 py-1"
            style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
          />
          分钟
        </label>

        <span data-testid="login-summary" className="ml-auto text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          {checkable.length} 个可检查 · {needsAck.length} 个待确认 · {notApproved.length} 个未审定
        </span>
        <span data-testid="login-queue-status" className="w-full text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          {queueStatus}
        </span>
      </div>

      {auto.enabled && (
        <p data-testid="auto-refresh-note" className="mb-4 rounded-lg p-3 text-xs"
          style={{ background: 'var(--color-panel)', color: 'var(--color-fg-dim)', border: '1px solid var(--color-warning)' }}>
          定时检查会**在后台反复**用你的登录态执行 whoami，可能唤起或切换浏览器标签页。
          只对已确认的命令生效；需要确认的会被跳过，不会弹窗打断你。关闭应用后不再执行。
        </p>
      )}

      <div className="rounded-lg" style={{ border: '1px solid var(--color-line)' }}>
        <details
          data-testid="login-group-action"
          open={actionGroupOpen}
          onToggle={(event) => setActionGroupOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">需要处理 ({actionRows.length})</summary>
          {renderRows(actionRows)}
        </details>
        <details data-testid="login-group-logged-in">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">已登录 ({loggedInRows.length})</summary>
          {renderRows(loggedInRows)}
        </details>
        <details data-testid="login-group-other">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">尚未审定 ({otherRows.length})</summary>
          {renderRows(otherRows)}
        </details>
        {rows.length === 0 && (
          <div className="px-3 py-4 text-sm" style={{ color: 'var(--color-fg-dim)' }}>目录里没有 whoami 命令</div>
        )}
      </div>
    </div>
  )
}

/** 自动刷新配置存在布局那份独立 key 里,**不进 preferences**(那是执行确认的存储,受 I-P7 管辖)。 */
function useAutoRefresh(): [{ enabled: boolean; minutes: number }, (v: { enabled: boolean; minutes: number }) => void] {
  const [value, setValue] = useState(() => {
    const l = loadLayout()
    return { enabled: l.autoLoginRefresh, minutes: l.autoLoginRefreshMinutes }
  })
  const set = (v: { enabled: boolean; minutes: number }) => {
    setValue(v)
    saveLayout({ ...loadLayout(), autoLoginRefresh: v.enabled, autoLoginRefreshMinutes: v.minutes })
  }
  return [value, set]
}
