import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Keyboard } from 'lucide-react'
import SplashCursor, { type SplashEmitter } from './SplashCursor.jsx'
import './StartupSplash.css'

const STARTUP_LABEL = '按任意键进入爪爪'
const EXIT_DURATION = 560
const SMOKE = { r: 0.022, g: 0.023, b: 0.026 }
const MIST = { r: 0.0032, g: 0.0033, b: 0.0038 }
// 中央一缕升起的轻烟 + 底部几处缓慢涌出的薄雾;只有上升与摆动,没有横向风。
const SMOKE_EMITTERS: SplashEmitter[] = [
  { x: 0.5, y: 0.04, radius: 0.03, force: { x: 0, y: 55 }, color: SMOKE, sway: 0.018, swayPeriod: 9, pulse: 0.35, pulsePeriod: 5, jitter: 22 },
  { x: 0.18, y: 0.01, radius: 0.4, force: { x: 0, y: 3 }, color: MIST, sway: 0.04, swayPeriod: 17, pulse: 0.5, pulsePeriod: 11, phase: 0.4, jitter: 14 },
  { x: 0.36, y: 0.0, radius: 0.36, force: { x: 0, y: 2 }, color: MIST, sway: 0.05, swayPeriod: 21, pulse: 0.5, pulsePeriod: 13, phase: 2.1, jitter: 14 },
  { x: 0.64, y: 0.01, radius: 0.38, force: { x: 0, y: 3 }, color: MIST, sway: 0.045, swayPeriod: 19, pulse: 0.5, pulsePeriod: 9, phase: 3.7, jitter: 14 },
  { x: 0.84, y: 0.0, radius: 0.4, force: { x: 0, y: 2 }, color: MIST, sway: 0.04, swayPeriod: 23, pulse: 0.5, pulsePeriod: 12, phase: 5.2, jitter: 14 },
]

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

export function StartupSplash({ children }: { children: ReactNode }) {
  const startRef = useRef<() => void>(() => {})
  const startedRef = useRef(false)
  const [leaving, setLeaving] = useState(false)
  const [visible, setVisible] = useState(true)
  const [smoke] = useState(() => !prefersReducedMotion())

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
          {smoke && (
            <SplashCursor
              RAINBOW_MODE={false}
              COLOR="#000000"
              SPLAT_FORCE={1200}
              CURL={12}
              DENSITY_DISSIPATION={0.8}
              VELOCITY_DISSIPATION={0.3}
              EMITTERS={SMOKE_EMITTERS}
              EMIT_WARMUP={3}
            />
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
