import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, LogOut, RefreshCw, SwitchCamera } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { siteLabel } from '../../data/zhCopy'
import { isAcknowledged } from '../../data/preferences'
import { stateFromDecision, type LoginCheckState } from '../../data/loginStatus'
import {
  AUTO_REFRESH_MAX_MINUTES, AUTO_REFRESH_MIN_MINUTES, clampIntervalMinutes,
} from '../../data/loginStatus'
import { loadLayout, saveLayout } from '../../data/layout'
import {
  SUPPORTED_SITES, siteForCommand, visibleCommands,
} from '../../data/supportedSites'
import type { CommandManifest } from '../../data/types'
import { useGlassMenuSurface } from '../../components/GlassMenu'

const STATE_TEXT: Record<LoginCheckState, string> = {
  unchecked: '未检查',
  queued: '排队中',
  checking: '检查中',
  'logged-in': '已登录',
  'logged-out': '需重新登录',
  error: '检查失败',
  'needs-ack': '需先确认',
  'not-approved': '未审定',
}

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

function statusBadge(state: LoginCheckState) {
  if (state === 'logged-in') return { tone: 'success', label: 'Success' }
  if (state === 'queued' || state === 'checking') return { tone: 'loading', label: 'Logging' }
  return { tone: 'failed', label: 'Failed' }
}

function AccountOperationMenu({
  site,
  state,
  busy,
  loginCommand,
  logoutCommand,
  onRefresh,
  onOpenCommand,
}: {
  site: string
  state: LoginCheckState
  busy: boolean
  loginCommand?: CommandManifest
  logoutCommand?: CommandManifest
  onRefresh: () => void
  onOpenCommand: (command: CommandManifest) => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRectRef = useRef<DOMRect>()
  const refreshDisabled = busy || state === 'not-approved'
  useGlassMenuSurface(menuRef, open)

  const placeMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    triggerRectRef.current = rect
    const width = 208
    setPosition({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    })
  }

  const closeMenu = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const openMenu = () => {
    placeMenu()
    setOpen(true)
  }

  useLayoutEffect(() => {
    if (!open || !menuRef.current || !triggerRectRef.current) return
    const menuHeight = menuRef.current.getBoundingClientRect().height
    if (position.top + menuHeight > window.innerHeight - 8) {
      setPosition((current) => ({
        ...current,
        top: Math.max(8, triggerRectRef.current!.top - menuHeight - 6),
      }))
    }
  }, [open, position.top])

  useEffect(() => {
    if (!open) return
    const focusId = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    })
    const dismiss = (event: globalThis.PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) closeMenu()
    }
    const reposition = () => closeMenu()
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.cancelAnimationFrame(focusId)
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open])

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!open) openMenu()
    }
    if (event.key === 'Escape' && open) closeMenu(true)
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    let next = current
    if (event.key === 'ArrowDown') next = Math.min(items.length - 1, current + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu(true)
      return
    } else if (event.key === 'Tab') {
      closeMenu()
      return
    } else return
    event.preventDefault()
    items[next]?.focus()
  }

  const runAction = (action: () => void) => {
    action()
    closeMenu(true)
  }

  const focusOnHover = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && !event.currentTarget.disabled) event.currentTarget.focus()
  }

  return (
    <div className="login-operation">
      <div className="login-operation-split" role="group" aria-label={`${siteLabel(site)}账号操作`}>
        <button
          type="button"
          data-testid={`login-refresh-${site}`}
          className="login-operation-refresh"
          disabled={refreshDisabled}
          title={busy ? '该站点已在检查队列中' : state === 'not-approved' ? '该站点当前尚未审定' : '重新检查该站点登录状态'}
          onClick={onRefresh}
        >
          <RefreshCw size={14} aria-hidden="true" />
          <span>刷新状态</span>
        </button>
        <button
          ref={triggerRef}
          type="button"
          data-testid={`login-operation-${site}`}
          className="login-operation-trigger"
          aria-label="更多账号操作"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => open ? closeMenu() : openMenu()}
          onKeyDown={onTriggerKeyDown}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${siteLabel(site)}账号操作`}
          className="login-operation-menu glass-menu-effect"
          style={position}
          onKeyDown={onMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="login-operation-item login-operation-item-danger"
            disabled={!logoutCommand}
            title={logoutCommand ? '进入退出账号命令详情' : '当前站点暂未提供退出命令'}
            onPointerMove={focusOnHover}
            onClick={() => logoutCommand && runAction(() => onOpenCommand(logoutCommand))}
          >
            <LogOut size={15} aria-hidden="true" />
            <span>退出当前账号</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="login-operation-item"
            disabled={!loginCommand}
            title={loginCommand ? '进入登录命令详情以切换账号' : '当前站点暂未提供登录命令'}
            onPointerMove={focusOnHover}
            onClick={() => loginCommand && runAction(() => onOpenCommand(loginCommand))}
          >
            <SwitchCamera size={15} aria-hidden="true" />
            <span>切换账号</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
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
  const setActiveModule = useAppStore((s) => s.setActiveModule)

  const [auto, setAuto] = useAutoRefresh()
  const now = Date.now()

  const rows = useMemo(() => {
    const catalog = visibleCommands(commands)
      .filter((command) => siteForCommand(command.site)?.id !== 'wechat')
    return catalog
      .filter((command) => command.name === 'whoami')
      .map((command) => {
        const decision = decisionFor(command.command)
        const acknowledged = !!decision?.fingerprint
          && isAcknowledged(preferences, command.command, decision.fingerprint)
        const derived = stateFromDecision(decision, acknowledged)
        const tracked = loginChecks[command.site]
        const state: LoginCheckState = derived === 'not-approved' || derived === 'needs-ack'
          ? derived
          : (tracked?.state ?? 'unchecked')
        const siteCommands = catalog.filter((candidate) => candidate.site === command.site)
        return {
          site: command.site,
          commandKey: command.command,
          command,
          decision,
          state,
          entry: tracked,
          supportedSite: siteForCommand(command.site),
          loginCommand: siteCommands.find((candidate) => ['login', 'signin', 'sign-in'].includes(candidate.name)),
          logoutCommand: siteCommands.find((candidate) => ['logout', 'signout', 'sign-out'].includes(candidate.name)),
        }
      })
      .sort((a, b) => {
        const siteRank = (site: string) => {
          const index = SUPPORTED_SITES.findIndex((item) => item.keys.includes(site))
          return index < 0 ? Number.MAX_SAFE_INTEGER : index
        }
        return siteRank(a.site) - siteRank(b.site) || a.site.localeCompare(b.site)
      })
  }, [commands, decisionFor, preferences, loginChecks])

  const checkable = rows.filter((row) => CHECKABLE.includes(row.state) || row.state === 'checking' || row.state === 'queued')
  const pending = loginQueue.length + loginInFlights.length
  const isRowBusy = (site: string) => loginInFlights.some((item) => item.site === site) || loginQueue.includes(site)

  useEffect(() => {
    if (!auto.enabled) return
    const tick = () => {
      const sites = visibleCommands(useAppStore.getState().commands)
        .filter((command) => siteForCommand(command.site)?.id !== 'wechat')
        .filter((command) => command.name === 'whoami')
        .filter((command) => {
          const decision = useAppStore.getState().decisionFor(command.command)
          const acknowledged = !!decision?.fingerprint
            && isAcknowledged(useAppStore.getState().preferences, command.command, decision.fingerprint)
          return CHECKABLE.includes(stateFromDecision(decision, acknowledged))
        })
        .map((command) => command.site)
      if (sites.length > 0) useAppStore.getState().enqueueLoginChecks(sites)
    }
    const id = setInterval(tick, auto.minutes * 60_000)
    return () => clearInterval(id)
  }, [auto.enabled, auto.minutes])

  const refreshRow = (row: typeof rows[number]) => {
    if (row.state === 'needs-ack') {
      selectCommand(row.command)
      if (row.decision) requestAcknowledgement(row.command, row.decision)
      return
    }
    if (CHECKABLE.includes(row.state)) enqueueLoginChecks([row.site])
  }

  const openAccountCommand = (command: CommandManifest) => {
    selectCommand(command)
    setActiveModule('commands')
  }

  return (
    <div className="login-status-page">
      <h2 className="login-status-title">登录状态</h2>
      <p className="login-status-subtitle">请持续保持你已登录的浏览器会话</p>

      <div className="login-status-toolbar">
        <button
          data-testid="refresh-all-logins"
          disabled={checkable.length === 0}
          onClick={() => enqueueLoginChecks(checkable.map((row) => row.site))}
          title="刷新全部站点登录状态"
          className="login-refresh-all"
        >
          {pending > 0 ? `全部刷新（排队 ${pending}）` : '全部刷新'}
        </button>

        <label className="login-auto-toggle">
          <span>定时检查</span>
          <input
            data-testid="auto-refresh-toggle"
            className="login-auto-toggle-input"
            type="checkbox"
            checked={auto.enabled}
            onChange={(event) => setAuto({ ...auto, enabled: event.target.checked })}
          />
          <span className="login-auto-toggle-track" aria-hidden="true">
            <span className="login-auto-toggle-indicator" />
            <span className="login-auto-toggle-thumb" />
          </span>
        </label>
        <label className="login-auto-interval">
          每
          <input
            data-testid="auto-refresh-minutes"
            type="number"
            min={AUTO_REFRESH_MIN_MINUTES}
            max={AUTO_REFRESH_MAX_MINUTES}
            value={auto.minutes}
            disabled={!auto.enabled}
            onChange={(event) => setAuto({ ...auto, minutes: clampIntervalMinutes(Number(event.target.value)) })}
          />
          分钟
        </label>
      </div>

      <div className="login-table-scroll" tabIndex={0} role="group" aria-label="登录状态表格">
        <table className="login-table" data-testid="login-status-table">
          <colgroup>
            <col className="login-col-site" />
            <col className="login-col-user" />
            <col className="login-col-time" />
            <col className="login-col-status" />
            <col className="login-col-operation" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Site</th>
              <th scope="col">User</th>
              <th scope="col">Last Time</th>
              <th scope="col">Status</th>
              <th scope="col">Operation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const badge = statusBadge(row.state)
              const busy = isRowBusy(row.site)
              return (
                <tr key={row.commandKey} data-testid={`login-row-${row.site}`}>
                  <td>
                    <div className="login-site-cell">
                      {row.supportedSite ? (
                        <span className="login-site-logo-wrap" style={{ '--site-tint': row.supportedSite.tint } as React.CSSProperties}>
                          <img
                            data-testid={`login-logo-${row.site}`}
                            className="login-site-logo"
                            src={row.supportedSite.logo}
                            alt=""
                          />
                        </span>
                      ) : <span className="login-site-fallback" aria-hidden="true">{siteLabel(row.site).slice(0, 1)}</span>}
                      <span>{row.supportedSite?.label ?? siteLabel(row.site)}</span>
                    </div>
                  </td>
                  <td className="login-user-cell" title={row.state === 'logged-in' ? row.entry?.detail : undefined}>
                    {row.state === 'logged-in' && row.entry?.detail ? row.entry.detail : '—'}
                  </td>
                  <td className="login-time-cell">{relativeTime(row.entry?.checkedAt, now)}</td>
                  <td>
                    <span
                      data-testid={`login-state-${row.site}`}
                      className={`login-status-badge login-status-badge-${badge.tone}`}
                      title={STATE_TEXT[row.state]}
                      aria-label={`${badge.label}：${STATE_TEXT[row.state]}`}
                    >
                      <span className="login-status-dot" aria-hidden="true" />
                      {badge.label}
                    </span>
                  </td>
                  <td>
                    <AccountOperationMenu
                      site={row.site}
                      state={row.state}
                      busy={busy}
                      loginCommand={row.loginCommand}
                      logoutCommand={row.logoutCommand}
                      onRefresh={() => refreshRow(row)}
                      onOpenCommand={openAccountCommand}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="login-table-empty">目录里没有 whoami 命令</div>}
      </div>
    </div>
  )
}

function useAutoRefresh(): [{ enabled: boolean; minutes: number }, (value: { enabled: boolean; minutes: number }) => void] {
  const [value, setValue] = useState(() => {
    const layout = loadLayout()
    return { enabled: layout.autoLoginRefresh, minutes: layout.autoLoginRefreshMinutes }
  })
  const set = (next: { enabled: boolean; minutes: number }) => {
    setValue(next)
    saveLayout({ ...loadLayout(), autoLoginRefresh: next.enabled, autoLoginRefreshMinutes: next.minutes })
  }
  return [value, set]
}
