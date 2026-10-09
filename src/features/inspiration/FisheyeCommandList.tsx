import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from 'motion/react'
import { ChevronRight, Plus } from 'lucide-react'
import type { CommandManifest } from '../../data/types'
import { commandDescription, commandTitle } from '../../data/zhCopy'
import { BookDemoButton } from '../../components/BookDemoButton'

/** 列表里的一组命令。title 为空表示不画分组标题(整张列表只有一组时)。 */
export type CommandSection = {
  key: string
  title: string
  note?: string
  commands: CommandManifest[]
  /** 可折叠的分组:collapsed 时不渲染其中的命令,标题行始终保留。 */
  collapsible?: boolean
  collapsed?: boolean
  onToggle?: () => void
}

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
  const zhTitle = commandTitle(command.command)
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
          <strong>{zhTitle ?? command.name}</strong>
          {zhTitle && <span className="fisheye-command-name">{command.name}</span>}
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

export function FisheyeCommandList({ commands, sections, onSubmit, canSubmit = () => true }: {
  commands?: CommandManifest[]
  sections?: CommandSection[]
  onSubmit: (command: CommandManifest) => void
  canSubmit?: (command: CommandManifest) => boolean
}) {
  const pointerY = useMotionValue(-9999)
  const blocks = useMemo<CommandSection[]>(
    () => sections ?? [{ key: 'all', title: '', commands: commands ?? [] }],
    [sections, commands],
  )
  // 折叠的分组不渲染命令;active/centers 的下标都对这条拍平后的可见序列。
  const visible = useMemo(() => blocks.flatMap((block) => (block.collapsed ? [] : block.commands)), [blocks])
  const [active, setActive] = useState<number | null>(visible.length > 0 ? 0 : null)
  const rows = useRef<(HTMLDivElement | null)[]>([])
  const centers = useRef<number[]>([])

  useEffect(() => {
    setActive(visible.length > 0 ? 0 : null)
    rows.current = rows.current.slice(0, visible.length)
  }, [visible])

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
  }, [visible])

  let nextIndex = 0
  return (
    <div
      data-testid="fisheye-command-list"
      className="fisheye-command-list"
      onMouseMove={(event) => pointerY.set(event.clientY)}
      onMouseLeave={() => { pointerY.set(-9999); setActive(null) }}
    >
      {blocks.map((block) => {
        const start = nextIndex
        if (!block.collapsed) nextIndex += block.commands.length
        return (
          <Fragment key={block.key}>
            {block.title && (
              <div className="fisheye-group-heading" data-testid={`command-group-${block.key}`}>
                {block.collapsible ? (
                  <button type="button" className="fisheye-group-toggle" aria-expanded={!block.collapsed} onClick={block.onToggle}>
                    <ChevronRight size={14} aria-hidden="true" className="fisheye-group-chevron" data-open={!block.collapsed} />
                    <span>{block.title}</span>
                  </button>
                ) : <span className="fisheye-group-title">{block.title}</span>}
                <small>{block.commands.length} 个</small>
                {block.note && <em>{block.note}</em>}
              </div>
            )}
            {!block.collapsed && block.commands.map((command, offset) => {
              const index = start + offset
              return (
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
              )
            })}
          </Fragment>
        )
      })}
    </div>
  )
}
