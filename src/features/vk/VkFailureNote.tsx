// 引擎失败原文的统一展示:一句结论 + 怎么办 + 可选动作,原文收进「原始信息」。
import { useMemo } from 'react'
import { describeVkFailure } from './vkFailure'
import './VkFailureNote.css'

export function VkFailureNote({ raw, className }: { raw: string; className?: string }) {
  const failure = useMemo(() => describeVkFailure(raw), [raw])
  return (
    <div className={`vk-failure-note${className ? ` ${className}` : ''}`} data-testid="vk-failure-note" data-kind={failure.kind}>
      <strong className="vk-failure-headline">{failure.headline}</strong>
      <p className="vk-failure-advice">{failure.advice}</p>
      {failure.action && (
        <button type="button" className="vk-failure-action" data-testid="vk-failure-action" onClick={failure.action.run}>
          {failure.action.label}
        </button>
      )}
      <details className="vk-failure-raw">
        <summary>原始信息</summary>
        <pre>{raw}</pre>
      </details>
    </div>
  )
}
