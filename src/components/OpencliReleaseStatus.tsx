import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import { X } from 'lucide-react'
import type { OpencliRelease } from '../host/opencliRelease'
import { OpencliReleasePanel } from './OpencliReleasePanel'
import { clampPercent, OpencliUpdateCard } from './OpencliUpdateCard'
import type { OpencliUpdate } from './useOpencliUpdate'
import './OpencliReleaseStatus.css'

export type ReleaseState = { state: 'idle' | 'checking' | 'error'; data?: OpencliRelease; error?: string }

const EXTENSION_STORE_NOTE = '商店版会由 Chrome 自动更新；装的是 GitHub 解压版的，改装商店版后就不用再手动下载'

const FRESH_MS = 60_000
const TICK_MS = 30_000
const pad = (value: number) => String(value).padStart(2, '0')

function checkedLabel(checkedAt: number, now: number): string {
  if (now - checkedAt < FRESH_MS) return '刚刚检查'
  const at = new Date(checkedAt)
  return `${pad(at.getHours())}:${pad(at.getMinutes())} 已检查`
}

function installedLabel(installedAt: number): string {
  const at = new Date(installedAt)
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())} 更新`
}

// 顶栏的 OpenCLI 版本区:平时只有一行可点的版本文字,点开是小面板(内置版本、检查更新、命令目录、发布说明);
// 检查中整块换成不定进度条,更新中换成确定进度条并在下方展开进度卡片。
export function OpencliReleaseStatus({ release, onCheck, update, commandCount }: {
  release: ReleaseState
  onCheck: () => void
  update: OpencliUpdate
  /** 命令目录条数;显示在面板里。 */
  commandCount?: number
}) {
  const checkedAt = release.data?.checkedAt
  const [now, setNow] = useState(() => Date.now())
  const triggerRef = useRef<HTMLButtonElement>(null)
  const refocusTrigger = useRef(false)
  const [panelAnchor, setPanelAnchor] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (checkedAt === undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [checkedAt])

  // 检查中、恢复中触发按钮被进度行替换,焦点会掉到 body;从面板里发起检查或恢复的,结束后把焦点还给触发按钮。
  // 恢复成功后紧接着是重查,等重查落地再还;恢复失败则在恢复结束时还。期间用户已把焦点移到别处就不再抢。
  useEffect(() => {
    if (release.state === 'checking' || update.rollingBack || !refocusTrigger.current) return
    refocusTrigger.current = false
    const active = document.activeElement
    if (!active || active === document.body) triggerRef.current?.focus()
  }, [release.state, update.rollingBack])

  const { card } = update
  const showingTrigger = !(update.updating && card) && !update.rollingBack && release.state !== 'checking'
  // 触发按钮被进度行替换时面板跟着收起,免得进度行换回触发按钮后面板又锚到已卸载的旧按钮上。
  useEffect(() => {
    if (!showingTrigger) setPanelAnchor(null)
  }, [showingTrigger])
  let body: ReactNode
  if (update.updating && card) {
    const percent = clampPercent(card.percent)
    body = (
      <div data-testid="opencli-update-progress" className="opencli-release-checking">
        <span className="opencli-release-tabular">更新 OpenCLI {card.version} · {Math.round(percent)}%</span>
        <div
          data-testid="opencli-update-bar"
          className="opencli-release-bar"
          role="progressbar"
          aria-label={`更新 OpenCLI ${card.version}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <span className="opencli-release-bar__fill opencli-release-bar__fill--determinate" style={{ width: `${percent}%` }} />
        </div>
      </div>
    )
  } else if (update.rollingBack) {
    body = (
      <div data-testid="opencli-rollback-progress" className="opencli-release-checking">
        <span>正在恢复内置 OpenCLI{release.data ? ` ${release.data.bundled}` : ''}…</span>
        <div className="opencli-release-bar" role="progressbar" aria-label="正在恢复内置 OpenCLI">
          <span className="opencli-release-bar__fill" />
        </div>
      </div>
    )
  } else if (release.state === 'checking') {
    body = (
      <div data-testid="opencli-release-checking" className="opencli-release-checking">
        <span>正在检查 OpenCLI 新版本…</span>
        <div className="opencli-release-bar" role="progressbar" aria-label="正在检查 OpenCLI 新版本">
          <span className="opencli-release-bar__fill" />
        </div>
      </div>
    )
  } else {
    const failed = release.state === 'error'
    const data = release.data
    let triggerText = 'OpenCLI 版本'
    if (failed) triggerText = data ? `OpenCLI ${data.active} · 检查失败` : '检查失败'
    else if (data?.updateAvailable) triggerText = `OpenCLI ${data.latest} 可用`
    else if (data) triggerText = `OpenCLI ${data.active} · 已是最新${data.activeInstalledAt ? ` · ${installedLabel(data.activeInstalledAt)}` : ''}`
    const tone = failed ? 'danger' : data?.updateAvailable ? 'accent' : undefined
    body = (
      <>
        <button ref={triggerRef} type="button" data-testid="opencli-release" className="opencli-release-trigger" data-tone={tone}
          aria-haspopup="dialog" aria-expanded={panelAnchor !== null} title={failed ? release.error : undefined}
          onClick={(event) => {
            const trigger = event.currentTarget
            setPanelAnchor((current) => (current ? null : trigger))
          }}>
          {triggerText}
        </button>
        {data?.updateAvailable && !failed && (
          <button type="button" data-testid="update-opencli" className="opencli-release-update"
            disabled={update.busy} onClick={() => void update.start(data.latest)}
            title={`把 OpenCLI 更新到 ${data.latest}`}>
            更新到 {data.latest}
          </button>
        )}
      </>
    )
  }

  return (
    <div className="opencli-release">
      {update.notice && (
        <span data-testid="opencli-update-error" role="alert" title={update.notice} className="opencli-release-error">{update.notice}</span>
      )}
      {body}
      <AnimatePresence>
        {panelAnchor && showingTrigger && (
          <OpencliReleasePanel
            key="opencli-release-panel"
            anchor={panelAnchor}
            rollbackTo={release.data && release.data.active !== release.data.bundled ? release.data.bundled : undefined}
            checkText={release.state === 'error'
              ? release.error || '检查失败'
              : release.data ? checkedLabel(release.data.checkedAt, now) : '还没有检查过'}
            commandCount={commandCount}
            notes={release.state !== 'error' && release.data?.updateAvailable
              ? { version: release.data.latest, url: release.data.releaseUrl }
              : undefined}
            busy={update.busy}
            onCheck={() => { refocusTrigger.current = true; update.clearNotice(); onCheck() }}
            onRollback={() => { refocusTrigger.current = true; void update.rollback() }}
            onClose={() => setPanelAnchor(null)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {card && (
          <OpencliUpdateCard
            key="opencli-update-card"
            job={card}
            onCancel={() => void update.cancel()}
            onRetry={() => void update.start(card.version)}
            onClose={update.dismissCard}
          />
        )}
      </AnimatePresence>
      {update.extensionWarning && (
        <div data-testid="opencli-extension-warning" role="status" className="opencli-release-warning">
          <span>{update.extensionWarning.message}。{EXTENSION_STORE_NOTE}</span>
          <button type="button" aria-label="关闭提示" title="关闭" className="opencli-release-warning__close" onClick={update.dismissWarning}>
            <X size={12} aria-hidden="true" />
          </button>
          <button type="button" data-testid="open-extension-store" className="opencli-release-update"
            disabled={update.busy} onClick={() => void update.openExtensionStore()}>
            在 Chrome 打开商店页
          </button>
        </div>
      )}
    </div>
  )
}
