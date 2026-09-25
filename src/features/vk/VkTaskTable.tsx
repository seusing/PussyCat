import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { InlineLoader } from 'generative-loaders'
import { Bell, BellOff, ChevronDown, Download, Trash2 } from 'lucide-react'
import type { VkJobRow } from '../../host/vkClient'
import { GlassSelect, useGlassMenuSurface } from '../../components/GlassMenu'
import 'generative-loaders/styles.css'
import './VkTaskTable.css'

export type VkTaskNotifications = Readonly<Record<string, boolean>>

export interface VkTaskTableProps {
  jobs: VkJobRow[]
  loading?: boolean
  selectedJobId?: string
  notifications: VkTaskNotifications
  onSelect: (row: VkJobRow) => void
  onOpen: (row: VkJobRow) => void
  onToggleNotification: (id: string, enabled: boolean) => void
  onSave: (row: VkJobRow) => void
  canSaveResult?: (row: VkJobRow) => boolean
  onDelete: (row: VkJobRow) => void
}

type NormalizedStatus = 'failed' | 'running' | 'rerunning' | 'stopping' | 'interrupted' | 'completed'

const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancel_requested', 'submitted', 'processing'])
const FAILED_STATUSES = new Set(['failed', 'quarantined', 'error'])
const INTERRUPTED_STATUSES = new Set(['cancelled', 'interrupted', 'completed_after_cancel_request'])
const OUTPUT_STATUSES = new Set(['done', 'partial'])

function normalizeStatus(row: VkJobRow): NormalizedStatus {
  const value = row.status.trim().toLowerCase()
  if (value === 'cancel_requested') return 'stopping'
  if (ACTIVE_STATUSES.has(value)) return row.parent_job_id || row.isRerun ? 'rerunning' : 'running'
  if (INTERRUPTED_STATUSES.has(value)) return 'interrupted'
  if (FAILED_STATUSES.has(value) || /fail|error|cancel|interrupt|quarantin/.test(value)) return 'failed'
  if (/queue|run|process|pending|submit/.test(value)) return 'running'
  return 'completed'
}

const STATUS_LABELS: Record<NormalizedStatus, string> = {
  failed: '失败',
  running: '正在执行',
  rerunning: '重跑中',
  stopping: '正在停止',
  interrupted: '已中断',
  completed: '已完成',
}

// 分页与筛选都是纯展示状态,放在表格自己身上;VkPanel 仍然只管把全量任务递进来。
const PAGE_SIZES = [10, 20, 50, 100] as const
const ALL_PAGE_SIZE = 'all'
type PageSize = (typeof PAGE_SIZES)[number] | typeof ALL_PAGE_SIZE

const STATUS_FILTERS: readonly { value: string; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'running', label: '正在执行' },
  { value: 'interrupted', label: '已中断' },
]

// 「重跑中」归到「正在执行」、「正在停止」也是,筛选器上再分这么细只会让人挑不中。
const STATUS_FILTER_MATCH: Record<string, ReadonlySet<NormalizedStatus>> = {
  completed: new Set<NormalizedStatus>(['completed']),
  failed: new Set<NormalizedStatus>(['failed']),
  running: new Set<NormalizedStatus>(['running', 'rerunning', 'stopping']),
  interrupted: new Set<NormalizedStatus>(['interrupted']),
}

const TIME_FILTERS: readonly { value: string; label: string; days: number | null }[] = [
  { value: 'all', label: '全部时间', days: null },
  { value: 'today', label: '今天', days: 0 },
  { value: '7d', label: '近 7 天', days: 7 },
  { value: '30d', label: '近 30 天', days: 30 },
]

function withinDays(value: string, days: number | null): boolean {
  if (days === null) return true
  const started = new Date(value)
  if (Number.isNaN(started.getTime())) return true    // 时间读不出来时不该把这条藏起来
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  if (days > 0) from.setDate(from.getDate() - days + 1)
  return started.getTime() >= from.getTime()
}

function startedAtLabel(value: string): string {
  if (!value) return '—'
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(parsed)
}

function stopRowSelection(event: MouseEvent<HTMLElement>): void {
  event.stopPropagation()
}

export function VkTaskTable({
  jobs,
  loading = false,
  selectedJobId,
  notifications,
  onSelect,
  onOpen,
  onToggleNotification,
  onSave,
  canSaveResult,
  onDelete,
}: VkTaskTableProps) {
  const [statusFilter, setStatusFilter] = useState('all')
  const [timeFilter, setTimeFilter] = useState('all')
  const [pageSize, setPageSize] = useState<PageSize>(10)
  const [page, setPage] = useState(1)
  const [menuJobId, setMenuJobId] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 })
  const [pendingDelete, setPendingDelete] = useState<VkJobRow | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRefs = useRef(new Map<string, HTMLButtonElement>())
  const cancelDeleteRef = useRef<HTMLButtonElement>(null)
  useGlassMenuSurface(menuRef, menuJobId !== null)

  useEffect(() => {
    if (!menuJobId) return
    const focusId = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    })
    const dismiss = (event: globalThis.PointerEvent) => {
      const target = event.target as Node
      const trigger = menuTriggerRefs.current.get(menuJobId)
      if (!menuRef.current?.contains(target) && !trigger?.contains(target)) setMenuJobId(null)
    }
    const dismissOnViewportChange = () => setMenuJobId(null)
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', dismissOnViewportChange)
    window.addEventListener('scroll', dismissOnViewportChange, true)
    return () => {
      window.cancelAnimationFrame(focusId)
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', dismissOnViewportChange)
      window.removeEventListener('scroll', dismissOnViewportChange, true)
    }
  }, [menuJobId])

  useEffect(() => {
    if (!pendingDelete) return
    cancelDeleteRef.current?.focus()
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setPendingDelete(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [pendingDelete])

  const closeMenu = (restoreFocus = false) => {
    const trigger = menuJobId ? menuTriggerRefs.current.get(menuJobId) : undefined
    setMenuJobId(null)
    if (restoreFocus) window.requestAnimationFrame(() => trigger?.focus())
  }

  const openMenu = (jobId: string) => {
    const rect = menuTriggerRefs.current.get(jobId)?.getBoundingClientRect()
    if (rect) {
      const width = 190
      const height = 88
      const top = rect.bottom + 6 + height <= window.innerHeight
        ? rect.bottom + 6
        : Math.max(8, rect.top - height - 6)
      setMenuPosition({
        top,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      })
    }
    setMenuJobId(jobId)
  }

  const runMenuAction = (action: () => void) => {
    action()
    closeMenu(true)
  }

  const filtered = useMemo(() => jobs.filter((row) => {
    const matchStatus = statusFilter === 'all'
      || (STATUS_FILTER_MATCH[statusFilter]?.has(normalizeStatus(row)) ?? true)
    const days = TIME_FILTERS.find((item) => item.value === timeFilter)?.days ?? null
    return matchStatus && withinDays(row.submitted_at, days)
  }), [jobs, statusFilter, timeFilter])

  const perPage = pageSize === ALL_PAGE_SIZE ? Math.max(1, filtered.length) : pageSize
  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage))
  // 筛完之后当前页可能已经不存在(例如停在第 5 页却筛剩两页),夹回最后一页而不是显示空表。
  const currentPage = Math.min(page, pageCount)
  const visible = useMemo(
    () => filtered.slice((currentPage - 1) * perPage, currentPage * perPage),
    [filtered, currentPage, perPage],
  )
  useEffect(() => {
    if (page !== currentPage) setPage(currentPage)
  }, [page, currentPage])

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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

  return (
    <div className="vk-task-table-shell" aria-busy={loading}>
      <div className="vk-task-table-toolbar">
        <label>
          <span>任务状态</span>
          <GlassSelect
            value={statusFilter}
            onChange={(value) => { setStatusFilter(value); setPage(1) }}
            aria-label="按任务状态筛选"
            options={STATUS_FILTERS}
          />
        </label>
        <label>
          <span>开始时间</span>
          <GlassSelect
            value={timeFilter}
            onChange={(value) => { setTimeFilter(value); setPage(1) }}
            aria-label="按开始时间筛选"
            options={TIME_FILTERS}
          />
        </label>
        <label className="vk-task-table-page-size">
          <span>每页</span>
          <GlassSelect
            value={String(pageSize)}
            onChange={(value) => {
              setPageSize(value === ALL_PAGE_SIZE ? ALL_PAGE_SIZE : (Number(value) as PageSize))
              setPage(1)
            }}
            aria-label="每页展示条数"
            options={[
              ...PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} 条` })),
              { value: ALL_PAGE_SIZE, label: '全部' },
            ]}
          />
        </label>
        <span className="vk-task-table-count" data-testid="vk-task-table-count">
          {filtered.length === jobs.length
            ? `共 ${jobs.length} 条`
            : `筛出 ${filtered.length} 条 / 共 ${jobs.length} 条`}
        </span>
      </div>
      <div className="vk-task-table-viewport">
        <table className="vk-task-table">
        <thead>
          <tr>
            <th scope="col">任务编号</th>
            <th scope="col">任务开始时间</th>
            <th scope="col">任务状态</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td className="vk-task-empty" colSpan={5}>
                {jobs.length === 0 ? '暂无任务' : '没有符合筛选条件的任务'}
              </td>
            </tr>
          )}
          {visible.map((row, index) => {
            const taskNumber = row.taskNumber ?? index + 1
            const notificationEnabled = notifications[row.job_id] ?? false
            const status = normalizeStatus(row)
            const canSaveOutput = canSaveResult?.(row) ?? OUTPUT_STATUSES.has(row.status.trim().toLowerCase())
            const selected = row.job_id === selectedJobId
            const menuOpen = row.job_id === menuJobId
            return (
              <tr
                key={row.job_id}
                data-testid="vk-job-row"
                data-selected={selected || undefined}
                aria-selected={selected}
                tabIndex={0}
                onClick={() => onSelect(row)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
                  event.preventDefault()
                  onSelect(row)
                }}
              >
                <td>
                  <div className="vk-task-number-cell">
                    {/* 「N 个视频」的徽标去掉了:它把编号列撑宽,详情栏一开就把右边的
                        「任务状态」整列挤出可视区,而条数在详情页的「提交内容」里写得
                        清清楚楚。**状态是每一行都要看的,条数不是** —— 列表这点宽度
                        该留给前者。悬停仍能从 title 里知道这一行是几个视频。 */}
                    <span
                      className="vk-task-number"
                      title={(row.batchMembers?.length ?? 0) > 1
                        ? `本次提交包含 ${row.batchMembers!.length} 个视频`
                        : undefined}
                    >
                      {taskNumber}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={notificationEnabled}
                      aria-label={`${notificationEnabled ? '关闭' : '开启'}任务 ${taskNumber} 完成通知`}
                      className="vk-task-notification-toggle"
                      data-state={notificationEnabled ? 'on' : 'off'}
                      onClick={(event) => {
                        stopRowSelection(event)
                        onToggleNotification(row.job_id, !notificationEnabled)
                      }}
                    >
                      {notificationEnabled
                        ? <Bell size={14} aria-hidden="true" />
                        : <BellOff size={14} aria-hidden="true" />}
                    </button>
                  </div>
                </td>
                <td>
                  <time dateTime={row.submitted_at} title={row.submitted_at}>{startedAtLabel(row.submitted_at)}</time>
                </td>
                <td>
                  <span className={`vk-task-badge is-${status}`} data-status={status}>{STATUS_LABELS[status]}</span>
                </td>
                <td>
                  <div className="vk-task-operation" onClick={stopRowSelection}>
                    <div className="vk-task-operation-split" role="group" aria-label={`任务 ${taskNumber} 操作`}>
                      <button
                        type="button"
                        data-testid={`vk-job-open-${row.job_id}`}
                        className="vk-task-open-button"
                        onClick={() => onOpen(row)}
                      >
                        打开
                      </button>
                      <button
                        ref={(element) => {
                          if (element) menuTriggerRefs.current.set(row.job_id, element)
                          else menuTriggerRefs.current.delete(row.job_id)
                        }}
                        type="button"
                        className="vk-task-menu-trigger"
                        aria-label={`任务 ${taskNumber} 更多操作`}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={() => menuOpen ? closeMenu() : openMenu(row.job_id)}
                        onKeyDown={(event) => {
                          if (event.key !== 'ArrowDown') return
                          event.preventDefault()
                          openMenu(row.job_id)
                        }}
                      >
                        <ChevronDown size={14} aria-hidden="true" />
                      </button>
                    </div>
                    {menuOpen && createPortal(
                      <div
                        ref={menuRef}
                        role="menu"
                        aria-label={`任务 ${taskNumber} 更多操作`}
                        className="vk-task-operation-menu glass-menu-effect"
                        style={menuPosition}
                        onClick={stopRowSelection}
                        onKeyDown={handleMenuKeyDown}
                      >
                        <button type="button" role="menuitem" tabIndex={-1} disabled={!canSaveOutput} aria-disabled={!canSaveOutput} onClick={() => runMenuAction(() => onSave(row))}>
                          <Download size={15} aria-hidden="true" />
                          <span>存到本地</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          tabIndex={-1}
                          className="is-danger"
                          onClick={() => {
                            setPendingDelete(row)
                            setMenuJobId(null)
                          }}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                          <span>删除执行记录</span>
                        </button>
                      </div>,
                      document.body,
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <nav className="vk-task-table-pager" aria-label="任务分页">
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => setPage(1)}
          >
            第一页
          </button>
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </button>
          <span data-testid="vk-task-table-page">第 {currentPage} / {pageCount} 页</span>
          <button
            type="button"
            disabled={currentPage >= pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </button>
          <button
            type="button"
            disabled={currentPage >= pageCount}
            onClick={() => setPage(pageCount)}
          >
            最后一页
          </button>
        </nav>
      )}

      {loading && (
        <div className="vk-task-table-loading" role="status" aria-live="polite">
          <InlineLoader variant="matrix" size={26} color="currentColor" label="正在刷新任务" />
          <span>正在读取最新任务…</span>
        </div>
      )}

      {pendingDelete && (
        <div className="vk-task-alert-backdrop" onMouseDown={(event) => event.stopPropagation()}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="vk-task-delete-title"
            aria-describedby="vk-task-delete-description"
            className="vk-task-alert-dialog"
          >
            <div className="vk-task-alert-icon"><Trash2 size={18} aria-hidden="true" /></div>
            <div>
              <h2 id="vk-task-delete-title">删除执行记录？</h2>
              <p id="vk-task-delete-description">此操作只删除任务记录，确认后立即生效。</p>
            </div>
            <div className="vk-task-alert-actions">
              <button ref={cancelDeleteRef} type="button" className="vk-task-alert-cancel" onClick={() => setPendingDelete(null)}>
                取消
              </button>
              <button
                type="button"
                className="vk-task-alert-confirm"
                onClick={() => {
                  const row = pendingDelete
                  setPendingDelete(null)
                  onDelete(row)
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
