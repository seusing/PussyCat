import type { ReactNode } from 'react'
import './EmptyState.css'

export function EmptyState({
  title,
  description,
  icon,
  className = '',
  children,
}: {
  title: string
  description?: string
  icon: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={`empty-state ${className}`.trim()} role="status" aria-label={title}>
      <div className="empty-state-icon" aria-hidden="true">{icon}</div>
      <strong>{title}</strong>
      {description && <span>{description}</span>}
      {children}
    </div>
  )
}
