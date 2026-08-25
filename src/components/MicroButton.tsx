import { AnimatePresence, motion } from 'motion/react'
import { Bookmark, CheckCheck, Copy, Send, Star } from 'lucide-react'
import { useState, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from 'react'

export type MicroButtonVariant = 'copy' | 'favorite' | 'save' | 'submit'

export interface MicroButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant: MicroButtonVariant
  active?: boolean
  children?: ReactNode
}

type IconState = 'copy' | 'star' | 'bookmark' | 'send' | 'check'

const variantAccent: Record<MicroButtonVariant, string> = {
  copy: '#a7b5c8',
  favorite: '#60a5fa',
  save: '#60a5fa',
  submit: '#34d399',
}

const variantIconClass: Record<MicroButtonVariant, string> = {
  copy: 'group-hover:text-slate-100 group-active:text-slate-100',
  favorite: 'group-hover:fill-blue-400 group-active:fill-blue-400 group-hover:text-blue-400 group-active:text-blue-400',
  save: 'group-hover:fill-blue-400 group-active:fill-blue-400 group-hover:text-blue-400 group-active:text-blue-400',
  submit: 'group-hover:text-emerald-400 group-active:text-emerald-400',
}

function iconForState(state: IconState) {
  switch (state) {
    case 'copy': return Copy
    case 'star': return Star
    case 'bookmark': return Bookmark
    case 'send': return Send
    case 'check': return CheckCheck
  }
}

function getIconState(variant: MicroButtonVariant, active: boolean, hovered: boolean, pressed: boolean): IconState {
  if ((active || hovered || pressed) && (variant === 'copy' || variant === 'submit')) return 'check'
  if (variant === 'favorite') return 'star'
  if (variant === 'save') return 'bookmark'
  if (variant === 'submit') return 'send'
  return 'copy'
}

export function MicroButton({
  variant,
  active = false,
  children,
  className = '',
  disabled = false,
  type = 'button',
  style,
  onMouseEnter,
  onMouseLeave,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  ...rest
}: MicroButtonProps) {
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)
  const iconState = getIconState(variant, active, hovered, pressed)
  const Icon = iconForState(iconState)
  const accent = variantAccent[variant]
  const tinted = (variant === 'favorite' || variant === 'save') && (active || hovered || pressed)
  const iconStyle: CSSProperties = {
    color: tinted || (active && (variant === 'copy' || variant === 'submit')) ? accent : 'currentColor',
    fill: tinted ? accent : 'none',
  }
  const baseStyle: CSSProperties = {
    height: 36,
    minWidth: 36,
    border: '1px solid rgba(255, 255, 255, 0.13)',
    borderRadius: 9999,
    background: variant === 'submit' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(255, 255, 255, 0.06)',
    color: 'var(--color-fg)',
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.16)',
    ...style,
  }

  const handleMouseEnter = (event: MouseEvent<HTMLButtonElement>) => {
    if (!disabled) setHovered(true)
    onMouseEnter?.(event)
  }
  const handleMouseLeave = (event: MouseEvent<HTMLButtonElement>) => {
    setHovered(false)
    setPressed(false)
    onMouseLeave?.(event)
  }
  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!disabled) setPressed(true)
    onPointerDown?.(event)
  }
  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    setPressed(false)
    onPointerUp?.(event)
  }
  const handlePointerCancel = (event: PointerEvent<HTMLButtonElement>) => {
    setPressed(false)
    onPointerCancel?.(event)
  }

  return (
    <motion.span
      className="inline-flex"
      whileHover={disabled ? undefined : { scale: 1.02 }}
      transition={{ type: 'spring', stiffness: 420, damping: 25, mass: 0.6 }}
    >
      <button
        {...rest}
        type={type}
        disabled={disabled}
        className={`group inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap px-3 text-sm font-medium leading-none transition-[background-color,border-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${variantIconClass[variant]} ${className}`}
        style={baseStyle}
        aria-pressed={variant === 'copy' || variant === 'favorite' || variant === 'save' ? active : undefined}
        data-variant={variant}
        data-state={variant === 'copy' && !active ? 'copy' : iconState}
        data-icon={iconState}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        <span className="inline-flex h-4 w-4 items-center justify-center" data-icon={iconState} aria-hidden="true">
          <AnimatePresence initial={false} mode="wait">
            <motion.span
              key={iconState}
              className="inline-flex h-4 w-4 items-center justify-center"
              initial={{ opacity: 0, scale: 0.68, rotate: -10 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={{ opacity: 0, scale: 0.68, rotate: 10 }}
              transition={{ type: 'spring', stiffness: 520, damping: 28, mass: 0.45 }}
            >
              <Icon size={15} strokeWidth={2.2} style={iconStyle} aria-hidden="true" />
            </motion.span>
          </AnimatePresence>
        </span>
        {children}
      </button>
    </motion.span>
  )
}
