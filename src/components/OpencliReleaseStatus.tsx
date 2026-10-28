import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import { X } from 'lucide-react'
import type { OpencliRelease } from '../host/opencliRelease'
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

// 顶栏的 OpenCLI 版本检查与应用内更新:检查中整块换成不定进度条,更新中换成确定进度条并在下方展开进度卡片。
export function OpencliReleaseStatus({ release, onCheck, update }: { release: ReleaseState; onCheck: () => void; update: OpencliUpdate }) {
  const checkedAt = release.data?.checkedAt
  const [now, setNow] = useState(() => Date.now())
  const buttonRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (checkedAt === undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [checkedAt])

  // 检查中按钮被进度行替换,焦点会掉到 body;由按钮发起且发起时焦点在按钮上的,结束后还回去。
  // 期间用户已把焦点移到别处就不再抢。
  useEffect(() => {
    if (release.state === 'checking' || !restoreFocus.current) return
    restoreFocus.current = false
    const active = document.activeElement
    if (!active || active === document.body) buttonRef.current?.focus()
  }, [release.state])

  const { card } = update
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
    const data = release.state !== 'error' ? release.data : undefined
    body = (
      <>
        {release.state === 'error' && (
          <span data-testid="opencli-release" title={release.error} style={{ color: 'var(--color-danger)' }}>检查失败</span>
        )}
        {data && (
          <>
            <span data-testid="opencli-release">
              {data.updateAvailable
                ? (
                  <>
                    <a href={data.releaseUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)' }}
                      title={`当前 ${data.current}`}>
                      OpenCLI {data.latest} 可用
                    </a>
                    <button type="button" data-testid="update-opencli" className="opencli-release-update"
                      disabled={update.busy} onClick={() => void update.start(data.latest)}
                      title={`把 OpenCLI 更新到 ${data.latest}`}>
                      更新到 {data.latest}
                    </button>
                  </>
                )
                : `OpenCLI ${data.current} · 已是最新`}
            </span>
            {data.active !== data.bundled && (
              <button type="button" data-testid="rollback-opencli" className="opencli-release-link"
                disabled={update.busy} onClick={() => void update.rollback()}
                aria-label="恢复内置版本" title={`退回安装包内置的 OpenCLI ${data.bundled}`}>
                恢复内置 {data.bundled}
              </button>
            )}
            <small data-testid="opencli-release-checked-at" className="opencli-release-note">{checkedLabel(data.checkedAt, now)}</small>
          </>
        )}
        <button ref={buttonRef} data-testid="check-updates"
          onClick={(event) => { restoreFocus.current = document.activeElement === event.currentTarget; update.clearNotice(); onCheck() }}
          className="rounded-lg px-2 py-1"
          style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
          title="检查 OpenCLI 有没有新版本">
          检查更新
        </button>
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
