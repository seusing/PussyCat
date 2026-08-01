// 费用确认对话框(拍板 5.5)。与 acknowledgement 是两套独立防线:
// acknowledgement 是持久化的一次性数据授权;费用确认**每次提交都问、绝不存储**——
// 金额随视频长度变,"记住我的选择"正是这道防线要防的。
import type { VkProcessingRequest } from '../../host/vkClient'
import type { VkEstimate } from './vkEstimates'
import { formatEstimate } from './vkEstimates'

export interface PendingVkSubmit {
  request: VkProcessingRequest
  estimate: VkEstimate
}

export function VkCostConfirmDialog({ pending, onConfirm, onCancel }: {
  pending: PendingVkSubmit | null
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!pending) return null
  const { request, estimate } = pending
  const formatted = formatEstimate(estimate)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)' }}>
      <div
        data-testid="vk-cost-dialog"
        className="w-full max-w-md rounded-lg p-4 text-sm shadow-lg"
        style={{ background: 'var(--color-panel)', color: 'var(--color-fg)', border: '1px solid var(--color-line)' }}
      >
        <div className="mb-2 text-base font-semibold">提交前费用确认</div>
        <div className="mb-3 break-all text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          {request.source}
        </div>
        <dl className="mb-3 space-y-1">
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--color-fg-dim)' }}>preset</dt>
            <dd>{request.preset}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--color-fg-dim)' }}>预估费用</dt>
            <dd data-testid="vk-cost-estimate">{formatted.cost}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--color-fg-dim)' }}>预估耗时</dt>
            <dd data-testid="vk-duration-estimate">{formatted.duration}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--color-fg-dim)' }}>费用硬上限</dt>
            <dd data-testid="vk-cost-cap">
              {request.max_cost_cny != null
                ? `¥${request.max_cost_cny}(最坏情况预估越界即终止)`
                : '未设置'}
            </dd>
          </div>
        </dl>
        <p className="mb-3 text-xs" style={{ color: 'var(--color-warning)' }}>
          以上是估算不是承诺;实际费用以任务视图的真实扣费为准。每次提交都会再次确认,不提供"记住选择"。
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="vk-cost-cancel"
            onClick={onCancel}
            className="rounded-lg px-3 py-1"
            style={{ color: 'var(--color-fg-dim)' }}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="vk-cost-confirm"
            onClick={onConfirm}
            className="rounded-lg px-4 py-2 font-medium"
            style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
          >
            确认提交
          </button>
        </div>
      </div>
    </div>
  )
}
