import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import SplashCursor from './SplashCursor.jsx'
import './StartupSplash.css'

const STARTUP_MESSAGE = 'Press any key to continue'
const EXIT_DURATION = 560

export function StartupSplash({ children }: { children: ReactNode }) {
  const startRef = useRef<() => void>(() => {})
  const startedRef = useRef(false)
  const [leaving, setLeaving] = useState(false)
  const [visible, setVisible] = useState(true)

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
          aria-label={STARTUP_MESSAGE}
          onPointerDown={() => startRef.current()}
          onKeyDown={(event) => {
            if (!event.repeat) startRef.current()
          }}
        >
          <SplashCursor RAINBOW_MODE />
          <p className="startup-splash__message">{STARTUP_MESSAGE}</p>
        </div>
      )}
    </>
  )
}
