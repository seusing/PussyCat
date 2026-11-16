import type { ReactNode } from 'react'
import { InfoTip } from './InfoTip'
import './EmptyState.css'

/** 空状态:一句话 + 至多一个操作。补充信息(如错误原文)收进标题旁的 ⓘ。 */
export function EmptyState({
  title,
  icon,
  detail,
  action,
  className = '',
}: {
  title: string
  icon: ReactNode
  detail?: string
  action?: { label: string; onClick: () => void; testId?: string }
  className?: string
}) {
  return (
    <div className={`empty-state ${className}`.trim()} role="status" aria-label={title}>
      <div className="empty-state-icon" aria-hidden="true">{icon}</div>
      <strong>
        {title}
        {detail && <InfoTip label="详细信息"><p>{detail}</p></InfoTip>}
      </strong>
      {action && (
        <button type="button" data-testid={action.testId} className="empty-state-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}
