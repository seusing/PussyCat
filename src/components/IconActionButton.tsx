import { useState, type ButtonHTMLAttributes } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { MorphIcon } from 'morphicons/react'
import type { IconNode } from 'lucide'
import './IconActionButton.css'

/** morphicons.com 播放器 snappy 预设(k=420, c=30)在 speed 0.5 下的弹簧;站点换算为 stiffness=k·s²、damping=c·s。 */
export const SNAPPY_HALF = { stiffness: 105, damping: 15 } as const

type IconActionButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: IconNode
  label: string
  tone?: 'danger'
}

/** 无边框图标按钮:悬停时图标放大回弹,icon 换了就在原地形变成新图标。 */
export function IconActionButton({
  icon,
  label,
  tone,
  className,
  type = 'button',
  disabled,
  onMouseEnter,
  onMouseLeave,
  ...rest
}: IconActionButtonProps) {
  const [hovered, setHovered] = useState(false)
  const reduceMotion = useReducedMotion()
  const classes = ['icon-action', tone === 'danger' ? 'is-danger' : '', className ?? ''].filter(Boolean).join(' ')

  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      className={classes}
      aria-label={label}
      title={label}
      onMouseEnter={(event) => { setHovered(true); onMouseEnter?.(event) }}
      onMouseLeave={(event) => { setHovered(false); onMouseLeave?.(event) }}
    >
      <motion.span
        className="icon-action-glyph"
        variants={{ rest: { scale: 1 }, hover: { scale: 1.12 } }}
        initial={false}
        animate={hovered && !disabled && !reduceMotion ? 'hover' : 'rest'}
        transition={{ type: 'spring', ...SNAPPY_HALF }}
      >
        <MorphIcon icon={icon} size={18} strokeWidth={1} spring={SNAPPY_HALF} reducedMotion="user" />
      </motion.span>
      <span className="sr-only">{label}</span>
    </button>
  )
}
