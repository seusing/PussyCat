import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { animate, createScope, engine, scrambleText } from 'animejs'
import './StartupSplash.css'

const STARTUP_MESSAGE = 'Let inspiration spark...'
const ENGINE_SPEED = 0.35
const EXIT_DELAY = 2_400
const EXIT_DURATION = 520

const PARTICLES = Array.from({ length: 52 }, (_, index) => ({
  x: ((index * 47) % 280) - 140,
  y: ((index * 83) % 144) - 72,
  size: 2 + (index % 4),
  tone: index % 3,
}))

const PARTICLE_COLORS = ['#8bb5ff', '#c9a7ff', '#f4cf78']

function isReducedMotionPreferred() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function StartupSplash({ children }: { children: ReactNode }) {
  const sceneRef = useRef<HTMLDivElement>(null)
  const messageRef = useRef<HTMLParagraphElement>(null)
  const [leaving, setLeaving] = useState(false)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return undefined

    let restored = false
    let scope: ReturnType<typeof createScope> | null = null
    const timers: number[] = []
    const previousSpeed = engine.speed

    const restoreEngine = () => {
      if (restored) return
      restored = true
      scope?.revert()
      engine.speed = previousSpeed
    }

    const beginExit = () => {
      setLeaving(true)
      timers.push(window.setTimeout(() => {
        restoreEngine()
        setVisible(false)
      }, EXIT_DURATION))
    }

    if (isReducedMotionPreferred()) {
      timers.push(window.setTimeout(beginExit, 360))
      return () => {
        timers.forEach((timer) => window.clearTimeout(timer))
        restoreEngine()
      }
    }

    engine.speed = ENGINE_SPEED
    scope = createScope({ root: scene }).add(() => {
      const particles = scene.querySelectorAll<HTMLElement>('.startup-splash__particle')
      const halo = scene.querySelector<HTMLElement>('.startup-splash__halo')
      const brand = scene.querySelector<HTMLElement>('.startup-splash__brand')

      animate(particles, {
        translateX: (_target: unknown, index = 0) => PARTICLES[index]?.x ?? 0,
        translateY: (_target: unknown, index = 0) => PARTICLES[index]?.y ?? 0,
        scale: [0.18, 1],
        opacity: [0, 0.88],
        delay: (_target: unknown, index = 0) => (index % 9) * 42,
        duration: 820,
        ease: 'out(3)',
        alternate: true,
        loop: true,
      })

      if (halo) {
        animate(halo, {
          scale: [0.84, 1.06],
          opacity: [0.42, 0.9],
          duration: 1_000,
          ease: 'inOut(2)',
          alternate: true,
          loop: true,
        })
      }

      if (brand) {
        animate(brand, {
          opacity: [0.55, 1],
          scale: [0.82, 1],
          duration: 560,
          ease: 'out(3)',
        })
      }

      if (messageRef.current) {
        animate(messageRef.current, {
          innerHTML: scrambleText({
            text: STARTUP_MESSAGE,
            from: 'center',
            cursor: '_',
            seed: 7,
          }),
          duration: 780,
          ease: 'out(3)',
        })
      }
    })

    timers.push(window.setTimeout(beginExit, EXIT_DELAY))
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      restoreEngine()
    }
  }, [])

  return (
    <>
      {children}
      {visible && (
        <div
          className={`startup-splash${leaving ? ' is-leaving' : ''}`}
          data-testid="startup-splash"
          role="status"
          aria-live="polite"
          aria-label={STARTUP_MESSAGE}
        >
          <div ref={sceneRef} className="startup-splash__scene" aria-hidden="true">
            <div className="startup-splash__field">
              <span className="startup-splash__corner startup-splash__corner--top-left" />
              <span className="startup-splash__corner startup-splash__corner--top-right" />
              <span className="startup-splash__corner startup-splash__corner--bottom-left" />
              <span className="startup-splash__corner startup-splash__corner--bottom-right" />
              <div className="startup-splash__halo" />
              <div className="startup-splash__particles">
                {PARTICLES.map((particle, index) => (
                  <span
                    key={index}
                    className="startup-splash__particle"
                    style={{
                      '--particle-size': `${particle.size}px`,
                      '--particle-color': PARTICLE_COLORS[particle.tone],
                    } as CSSProperties}
                  />
                ))}
              </div>
              <div className="startup-splash__brand">
                <span className="startup-splash__brand-mark">
                  <img src="/app-icon.png" alt="" />
                </span>
                <strong>爪爪</strong>
              </div>
            </div>
          </div>
          <p ref={messageRef} className="startup-splash__message">{STARTUP_MESSAGE}</p>
        </div>
      )}
    </>
  )
}
