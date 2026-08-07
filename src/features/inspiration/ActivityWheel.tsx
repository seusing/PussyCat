import { useRef, useState, type CSSProperties, type WheelEvent } from 'react'
import { motion } from 'motion/react'
import { BorderBeam } from 'border-beam'
import type { SupportedSite } from '../../data/supportedSites'

const ARC_RADIUS = 140
const ARC_STEP_DEG = 13
const WHEEL_STEP_THRESHOLD = 40
const WHEEL_STEP_COOLDOWN_MS = 150

export function ActivityWheel({ sites, onSelect }: { sites: SupportedSite[]; onSelect: (site: SupportedSite) => void }) {
  const [selected, setSelected] = useState(() => Math.min(3, Math.max(0, sites.length - 1)))
  const wheelAccum = useRef(0)
  const lastStepAt = useRef(0)
  if (sites.length === 0) return null

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    wheelAccum.current += event.deltaY
    if (Math.abs(wheelAccum.current) < WHEEL_STEP_THRESHOLD) return
    const now = performance.now()
    if (now - lastStepAt.current < WHEEL_STEP_COOLDOWN_MS) {
      wheelAccum.current = 0
      return
    }
    const direction = Math.sign(wheelAccum.current)
    wheelAccum.current = 0
    lastStepAt.current = now
    setSelected((index) => Math.max(0, Math.min(sites.length - 1, index + direction)))
  }

  return (
    <div data-testid="activity-wheel" className="activity-wheel" onWheel={onWheel}>
      <div className="activity-wheel-viewport">
        <svg viewBox="0 0 300 300" className="activity-wheel-arcs" preserveAspectRatio="none" aria-hidden="true">
          <circle cx="404" cy="150" r="140" fill="none" strokeWidth="1" strokeDasharray="2 4" className="activity-wheel-arc-primary" />
          <circle cx="404" cy="150" r="125" fill="none" strokeWidth="1" strokeDasharray="2 4" className="activity-wheel-arc-secondary" />
        </svg>

        <div className="activity-wheel-list">
          {sites.map((site, index) => {
            const offset = index - selected
            const distance = Math.abs(offset)
            const angle = offset * ARC_STEP_DEG * Math.PI / 180
            const x = ARC_RADIUS * (1 - Math.cos(angle))
            const y = ARC_RADIUS * Math.sin(angle)
            const active = offset === 0
            return (
              <motion.button
                key={site.id}
              type="button"
              data-testid={`wheel-site-${site.id}`}
              aria-label={active ? `打开 ${site.label}` : `选择 ${site.label}`}
              aria-pressed={active}
              onClick={() => { if (active) onSelect(site); else setSelected(index) }}
              className="activity-wheel-item"
              initial={false}
              style={{ '--site-tint': site.tint } as CSSProperties}
              animate={{
                x,
                y,
                scale: 1 - Math.min(distance, 3) * 0.07,
                opacity: distance > 3 ? 0 : 1 - distance * 0.22,
              }}
              transition={{ type: 'spring', stiffness: 240, damping: 26, mass: 0.7 }}
            >
              <span className="activity-wheel-label" data-active={active}>{site.label}</span>
              <BorderBeam
                size="line"
                colorVariant="colorful"
                strength={1}
                borderRadius={19}
                active={active}
                className="activity-wheel-beam"
              >
                <span className="activity-wheel-logo" data-active={active}>
                  <img src={site.logo} alt="" />
                </span>
              </BorderBeam>
              <span className="activity-wheel-marker" data-active={active} />
              </motion.button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
