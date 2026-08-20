import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type TooltipRect = { left: number; top: number; width: number }

export function OverflowTooltip({
  text,
  children,
  className,
  labelClassName,
  labelStyle,
  testId,
}: {
  text: string
  children?: ReactNode
  className?: string
  labelClassName?: string
  labelStyle?: CSSProperties
  testId?: string
}) {
  const labelRef = useRef<HTMLSpanElement>(null)
  const leaveTimer = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [rect, setRect] = useState<TooltipRect | null>(null)

  const clearLeaveTimer = () => {
    if (leaveTimer.current == null) return
    window.clearTimeout(leaveTimer.current)
    leaveTimer.current = null
  }

  const showIfOverflow = () => {
    clearLeaveTimer()
    const element = labelRef.current
    if (!element || !text) return
    if (element.scrollWidth <= element.clientWidth + 1) {
      setOpen(false)
      setRect(null)
      return
    }
    const next = element.getBoundingClientRect()
    setRect({ left: next.left, top: next.top, width: next.width })
    setLeaving(false)
    setOpen(true)
  }

  const hide = () => {
    clearLeaveTimer()
    if (!open) return
    setLeaving(true)
    leaveTimer.current = window.setTimeout(() => {
      setOpen(false)
      setLeaving(false)
      setRect(null)
    }, 50)
  }

  useEffect(() => () => clearLeaveTimer(), [])

  return (
    <span
      data-testid={testId}
      className={['overflow-tooltip', className].filter(Boolean).join(' ')}
      onMouseEnter={showIfOverflow}
      onFocus={showIfOverflow}
      onMouseLeave={hide}
      onBlur={hide}
    >
      <span ref={labelRef} className={['overflow-tooltip__label', labelClassName].filter(Boolean).join(' ')} style={labelStyle}>
        {children ?? text}
      </span>
      {open && rect && createPortal(
        <span
          role="tooltip"
          className={`overflow-tooltip__bubble${leaving ? ' is-leaving' : ''}`}
          style={{ left: rect.left, top: rect.top - 8, maxWidth: `min(24rem, calc(100vw - ${Math.max(16, rect.left)}px - 12px))` }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  )
}
