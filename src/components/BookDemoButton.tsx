import type { ButtonHTMLAttributes, CSSProperties } from 'react'

export type BookDemoVariant = 'lime' | 'sky' | 'rose' | 'amber' | 'emerald' | 'violet' | 'orange' | 'magenta'

const VARIANTS: Record<BookDemoVariant, { from: string; to: string; dot: string }> = {
  lime: { from: '#d6f54a', to: '#c5ea2c', dot: '#0f0f0f' },
  sky: { from: '#a5e0ff', to: '#6bc8f5', dot: '#0a1f3a' },
  rose: { from: '#ffc4d3', to: '#f590a5', dot: '#3a0a1f' },
  amber: { from: '#ffd66e', to: '#f5a82e', dot: '#3a210a' },
  emerald: { from: '#a8efc5', to: '#5fd49a', dot: '#0a2a1a' },
  violet: { from: '#d4b9ff', to: '#a07bf5', dot: '#1f0a3a' },
  orange: { from: '#ffb88a', to: '#f57a3a', dot: '#3a190a' },
  magenta: { from: '#f5a8e0', to: '#e060c5', dot: '#3a0a2a' },
}

const DOTS = [
  [2, 2], [5, 5], [8, 8], [5, 11], [2, 14],
  [6, 2], [9, 5], [12, 8], [9, 11], [6, 14],
]

function ChevronDots({ index, color }: { index: number; color: string }) {
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true">
      <g fill={color}>
        {DOTS.map(([cx, cy], dot) => (
          <circle
            key={`${cx}-${cy}`}
            cx={cx}
            cy={cy}
            r="1"
            className="book-demo-dot"
            style={{ animationDelay: `${index * 0.12 + dot * 0.05}s` }}
          />
        ))}
      </g>
    </svg>
  )
}

export function BookDemoButton({
  children = '填写参数',
  className = '',
  variant = 'violet',
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BookDemoVariant }) {
  const colors = VARIANTS[variant]
  const css = {
    '--book-demo-from': colors.from,
    '--book-demo-to': colors.to,
    '--book-demo-dot': colors.dot,
    ...style,
  } as CSSProperties

  return (
    <button className={`book-demo-button ${className}`} style={css} {...props}>
      <span className="book-demo-label">{children}</span>
      <span className="book-demo-sweep" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => <ChevronDots key={index} index={index} color={colors.dot} />)}
      </span>
    </button>
  )
}
