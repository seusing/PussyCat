import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { animate, createScope, engine, scrambleText } from 'animejs'
import './StartupSplash.css'

const STARTUP_MESSAGE = 'Press any key to continue'
const ENGINE_SPEED = 0.35
const EXIT_DURATION = 560

type Particle = {
  x: number
  y: number
  size: number
  drift: number
  lift: number
  rotation: number
  duration: number
  delay: number
  tone: number
  opacity: number
}

function seeded(index: number, salt: number) {
  const value = Math.sin((index + 1) * (12.9898 + salt * 78.233)) * 43758.5453
  return value - Math.floor(value)
}

const PARTICLES: Particle[] = Array.from({ length: 128 }, (_, index) => {
  const x = (seeded(index, 1) - 0.5) * 86
  const centerDensity = 0.34 + 0.66 * (1 - Math.min(1, Math.abs(x) / 43))
  const y = (seeded(index, 2) - 0.5) * (20 + centerDensity * 26) + Math.sin(index * 0.71) * 3
  return {
    x,
    y,
    size: 3 + Math.round(seeded(index, 3) * 10),
    drift: 7 + Math.round(seeded(index, 4) * 24),
    lift: 5 + Math.round(seeded(index, 5) * 18),
    rotation: 4 + Math.round(seeded(index, 6) * 18),
    duration: 1_150 + Math.round(seeded(index, 7) * 1_300),
    delay: Math.round(seeded(index, 8) * 900),
    tone: index % 5,
    opacity: 0.55 + seeded(index, 9) * 0.45,
  }
})

const PARTICLE_COLORS = ['#f7b5ff', '#c084fc', '#fff2ff', '#ff72d2', '#91b8ff']

function isReducedMotionPreferred() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function StartupSplash({ children }: { children: ReactNode }) {
  const sceneRef = useRef<HTMLDivElement>(null)
  const messageRef = useRef<HTMLParagraphElement>(null)
  const startRef = useRef<() => void>(() => {})
  const startedRef = useRef(false)
  const [leaving, setLeaving] = useState(false)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return undefined

    let restored = false
    let scope: ReturnType<typeof createScope> | null = null
    const timers: number[] = []
    const previousSpeed = engine.speed

    const restore = () => {
      if (restored) return
      restored = true
      scope?.revert()
      engine.speed = previousSpeed
    }

    const beginStart = () => {
      if (startedRef.current) return
      startedRef.current = true
      setLeaving(true)
      timers.push(window.setTimeout(() => {
        restore()
        setVisible(false)
      }, EXIT_DURATION))
    }

    startRef.current = beginStart
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.repeat) beginStart()
    }
    window.addEventListener('keydown', onKeyDown)

    if (!isReducedMotionPreferred()) {
      engine.speed = ENGINE_SPEED
      scope = createScope({ root: scene }).add(() => {
        const particles = scene.querySelectorAll<HTMLElement>('.startup-splash__particle')
        const coreGlow = scene.querySelector<HTMLElement>('.startup-splash__core-glow')
        const energyLines = scene.querySelectorAll<HTMLElement>('.startup-splash__energy')

        animate(particles, {
          translateX: (_target: unknown, index = 0) => {
            const particle = PARTICLES[index]
            return particle ? [-particle.drift, particle.drift, -particle.drift] : 0
          },
          translateY: (_target: unknown, index = 0) => {
            const particle = PARTICLES[index]
            return particle ? [particle.lift, -particle.lift, particle.lift] : 0
          },
          scale: (_target: unknown, index = 0) => {
            const particle = PARTICLES[index]
            return particle ? [0.72, 1.35 + (particle.size / 18), 0.78] : 1
          },
          rotate: (_target: unknown, index = 0) => {
            const particle = PARTICLES[index]
            return particle ? [`-${particle.rotation}deg`, `${particle.rotation}deg`] : '0deg'
          },
          opacity: (_target: unknown, index = 0) => {
            const particle = PARTICLES[index]
            return particle
              ? [particle.opacity * 0.65, Math.min(1, particle.opacity * 1.18), particle.opacity * 0.72]
              : 0.5
          },
          delay: (_target: unknown, index = 0) => PARTICLES[index]?.delay ?? 0,
          duration: (_target: unknown, index = 0) => PARTICLES[index]?.duration ?? 1_500,
          ease: 'inOut(2)',
          alternate: true,
          loop: true,
        })

        if (coreGlow) {
          animate(coreGlow, {
            scale: [0.72, 1.16],
            opacity: [0.24, 0.7],
            duration: 1_800,
            ease: 'inOut(2)',
            alternate: true,
            loop: true,
          })
        }

        animate(energyLines, {
          translateX: (_target: unknown, index = 0) => (index % 2 === 0 ? -52 : 52),
          scaleX: [0.56, 1, 0.56],
          opacity: [0.04, 0.24, 0.04],
          duration: 1_900,
          delay: (_target: unknown, index = 0) => index * 180,
          ease: 'inOut(2)',
          alternate: true,
          loop: true,
        })

        if (messageRef.current) {
          animate(messageRef.current, {
            innerHTML: scrambleText({
              text: STARTUP_MESSAGE,
              from: 'center',
              cursor: '_',
              seed: 7,
            }),
            duration: 1_050,
            ease: 'out(3)',
          })
          animate(messageRef.current, {
            opacity: [0.42, 1],
            duration: 1_250,
            ease: 'inOut(2)',
            alternate: true,
            loop: true,
          })
        }
      })
    }

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      window.removeEventListener('keydown', onKeyDown)
      startRef.current = () => {}
      restore()
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
          <div ref={sceneRef} className="startup-splash__scene" aria-hidden="true">
            <div className="startup-splash__field">
              <div className="startup-splash__grid" />
              <div className="startup-splash__core-glow" />
              <span className="startup-splash__energy startup-splash__energy--one" />
              <span className="startup-splash__energy startup-splash__energy--two" />
              <span className="startup-splash__energy startup-splash__energy--three" />
              <div className="startup-splash__particles">
                {PARTICLES.map((particle, index) => (
                  <span
                    key={index}
                    className={`startup-splash__particle${particle.tone === 2 ? ' is-bright' : ''}`}
                    style={{
                      left: `${50 + particle.x}%`,
                      top: `${50 + particle.y}%`,
                      '--particle-size': `${particle.size}px`,
                      '--particle-color': PARTICLE_COLORS[particle.tone],
                      '--particle-opacity': particle.opacity,
                    } as CSSProperties}
                  />
                ))}
              </div>
            </div>
          </div>
          <p ref={messageRef} className="startup-splash__message">{STARTUP_MESSAGE}</p>
        </div>
      )}
    </>
  )
}
