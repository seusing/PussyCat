import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Keyboard } from 'lucide-react'
import Prism from './Prism'
import './StartupSplash.css'

const STARTUP_LABEL = '按任意键进入爪爪'
const EXIT_DURATION = 560

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

export function StartupSplash({ children }: { children: ReactNode }) {
  const startRef = useRef<() => void>(() => {})
  const startedRef = useRef(false)
  const [leaving, setLeaving] = useState(false)
  const [visible, setVisible] = useState(true)
  const [animated] = useState(() => !prefersReducedMotion())

  useEffect(() => {
    let exitTimer: number | undefined

    const beginStart = () => {
      if (startedRef.current) return
      startedRef.current = true
      setLeaving(true)
      exitTimer = window.setTimeout(() => setVisible(false), EXIT_DURATION)
    }

    startRef.current = beginStart
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.repeat) beginStart()
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (exitTimer !== undefined) window.clearTimeout(exitTimer)
      startRef.current = () => {}
    }
  }, [])

  return (
    <>
      {children}
      {visible && (
        <div
          className={`startup-splash${leaving ? ' is-leaving' : ''}`}
          data-testid="startup-splash"
          role="button"
          tabIndex={0}
          aria-label={STARTUP_LABEL}
          onPointerDown={() => startRef.current()}
          onKeyDown={(event) => {
            if (!event.repeat) startRef.current()
          }}
        >
          {animated && (
            <div className="startup-splash__prism" aria-hidden="true">
              <Prism animationType="rotate" />
            </div>
          )}
          <div className="startup-splash__brand">
            <img className="startup-splash__icon" src="/app-icon.png" alt="" aria-hidden="true" />
            <strong className="startup-splash__name">爪爪</strong>
            <span className="startup-splash__tagline">把值得回看的视频、来源和想法放在一个地方。</span>
          </div>
          <span className="startup-splash__hint">
            <Keyboard size={15} aria-hidden="true" />
            按任意键进入
          </span>
        </div>
      )}
    </>
  )
}
