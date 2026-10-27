import { useEffect, useRef, useState } from 'react'
import type { OpencliRelease } from '../host/opencliRelease'
import './OpencliReleaseStatus.css'

export type ReleaseState = { state: 'idle' | 'checking' | 'error'; data?: OpencliRelease; error?: string }

const FRESH_MS = 60_000
const TICK_MS = 30_000
const pad = (value: number) => String(value).padStart(2, '0')

function checkedLabel(checkedAt: number, now: number): string {
  if (now - checkedAt < FRESH_MS) return '刚刚检查'
  const at = new Date(checkedAt)
  return `${pad(at.getHours())}:${pad(at.getMinutes())} 已检查`
}

// 顶栏的 OpenCLI 版本检查:只展示结果,检查中整块换成不定进度条。
export function OpencliReleaseStatus({ release, onCheck }: { release: ReleaseState; onCheck: () => void }) {
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

  if (release.state === 'checking') {
    return (
      <div data-testid="opencli-release-checking" className="opencli-release-checking">
        <span>正在检查 OpenCLI 新版本…</span>
        <div className="opencli-release-bar" role="progressbar" aria-label="正在检查 OpenCLI 新版本">
          <span className="opencli-release-bar__fill" />
        </div>
      </div>
    )
  }

  return (
    <>
      {release.state === 'error' && (
        <span data-testid="opencli-release" title={release.error} style={{ color: 'var(--color-danger)' }}>检查失败</span>
      )}
      {release.state !== 'error' && release.data && (
        <>
          <span data-testid="opencli-release">
            {release.data.updateAvailable
              ? (
                <>
                  <a href={release.data.releaseUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)' }}
                    title={`当前 ${release.data.current}，新版 OpenCLI 会随爪爪新版本提供`}>
                    OpenCLI {release.data.latest} 可用
                  </a>
                  <small className="opencli-release-note">随下一版爪爪提供</small>
                </>
              )
              : `OpenCLI ${release.data.current} · 已是最新`}
          </span>
          <small data-testid="opencli-release-checked-at" className="opencli-release-note">{checkedLabel(release.data.checkedAt, now)}</small>
        </>
      )}
      <button ref={buttonRef} data-testid="check-updates"
        onClick={(event) => { restoreFocus.current = document.activeElement === event.currentTarget; onCheck() }}
        className="rounded-lg px-2 py-1"
        style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
        title="检查 OpenCLI 有没有新版本">
        检查更新
      </button>
    </>
  )
}
