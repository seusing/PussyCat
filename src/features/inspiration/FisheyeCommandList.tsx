import { useEffect, useRef, useState } from 'react'
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from 'motion/react'
import { Plus } from 'lucide-react'
import type { CommandManifest } from '../../data/types'
import { commandDescription } from '../../data/zhCopy'
import { BookDemoButton } from '../../components/BookDemoButton'

const RANGE = 110
const MAX_SCALE = 1.12
const TRACK_SPRING = { stiffness: 260, damping: 26, mass: 0.6 } as const
const ICON_SPRING = { type: 'spring', visualDuration: 0.3, bounce: 0.25 } as const

function CommandRow({
  command,
  index,
  pointerY,
  centers,
  active,
  onActivate,
  onSubmit,
  canSubmit,
  register,
}: {
  command: CommandManifest
  index: number
  pointerY: MotionValue<number>
  centers: { current: number[] }
  active: boolean
  onActivate: () => void
  onSubmit: () => void
  canSubmit: boolean
  register: (element: HTMLDivElement | null) => void
}) {
  const reduce = useReducedMotion()
  const scaleTarget = useTransform(pointerY, (y) => {
    const center = centers.current[index]
    if (center == null || !Number.isFinite(center)) return 1
    const proximity = Math.max(0, 1 - Math.abs(y - center) / RANGE)
    return 1 + proximity * (MAX_SCALE - 1)
  })
  const scale = useSpring(scaleTarget, TRACK_SPRING)

  return (
    <motion.div
      ref={register}
      data-testid={`command-row-${command.command}`}
      onMouseMove={onActivate}
      style={{ scale: reduce ? 1 : scale, transformOrigin: 'center', zIndex: active ? 2 : 1 }}
      className="fisheye-command-row"
    >
      <button
        type="button"
        onClick={() => { if (active) onSubmit(); else onActivate() }}
        onFocus={onActivate}
        aria-expanded={active}
        className="fisheye-command-header"
      >
        <span>
          <strong>{command.name}</strong>
          <small>{command.access === 'write' ? '写入' : '读取'}</small>
        </span>
        <motion.span animate={{ rotate: active ? 45 : 0 }} transition={ICON_SPRING}>
          <Plus size={18} />
        </motion.span>
      </button>

      <div
        data-active={active}
        aria-hidden={!active}
        className="fisheye-command-detail-clip"
      >
        <div className="fisheye-command-detail-shell">
          <div className="fisheye-command-detail">
            <p>{commandDescription(command.command, command.description)}</p>
            <BookDemoButton
              data-testid={`open-command-${command.command}`}
              aria-label="运行任务：进入命令详情"
              disabled={!canSubmit}
              tabIndex={active ? undefined : -1}
              onClick={onSubmit}
            >
              进入命令详情
            </BookDemoButton>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

export function FisheyeCommandList({ commands, onSubmit, canSubmit = () => true }: { commands: CommandManifest[]; onSubmit: (command: CommandManifest) => void; canSubmit?: (command: CommandManifest) => boolean }) {
  const pointerY = useMotionValue(-9999)
  const [active, setActive] = useState<number | null>(commands.length > 0 ? 0 : null)
  const rows = useRef<(HTMLDivElement | null)[]>([])
  const centers = useRef<number[]>([])

  useEffect(() => {
    setActive(commands.length > 0 ? 0 : null)
    rows.current = rows.current.slice(0, commands.length)
  }, [commands])

  useEffect(() => {
    const measure = () => {
      centers.current = rows.current.map((element) => {
        if (!element) return Number.POSITIVE_INFINITY
        const rect = element.getBoundingClientRect()
        return rect.top + rect.height / 2
      })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    rows.current.forEach((element) => element && observer?.observe(element))
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [commands])

  return (
    <div
      data-testid="fisheye-command-list"
      className="fisheye-command-list"
      onMouseMove={(event) => pointerY.set(event.clientY)}
      onMouseLeave={() => { pointerY.set(-9999); setActive(null) }}
    >
      {commands.map((command, index) => (
        <CommandRow
          key={command.command}
          command={command}
          index={index}
          pointerY={pointerY}
          centers={centers}
          active={active === index}
          onActivate={() => setActive(index)}
          onSubmit={() => onSubmit(command)}
          canSubmit={canSubmit(command)}
          register={(element) => { rows.current[index] = element }}
        />
      ))}
    </div>
  )
}
