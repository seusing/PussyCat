import { motion, useReducedMotion } from 'motion/react'
import { Check, Package, RotateCw, X } from 'lucide-react'
import type { OpencliUpdateJob, OpencliUpdateStage } from '../host/opencliRelease'
import './OpencliUpdateCard.css'

const SPRING = { type: 'spring', stiffness: 400, damping: 32 } as const
const PROGRESS_OPEN_HEIGHT = 12   // 上边距 8 + 进度条 4

const STAGE_TEXT: Record<Exclude<OpencliUpdateStage, 'download'>, string> = {
  resolve: '查找版本',
  install: '安装依赖',
  native: '装回原生命令',
  prune: '精简站点',
  verify: '校验',
  switch: '切换',
  done: '完成',
}
// 这两个阶段没有可量化的进度,填充上加流光表示仍在工作。
const SLOW_STAGES: OpencliUpdateStage[] = ['install', 'verify']

export const clampPercent = (value: number) => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0)

// 不传 percent 时只给阶段级文字,供读屏播报:百分比每 300ms 变一次,交给进度条的 aria-valuenow。
function statusText(job: OpencliUpdateJob, percent?: number): string {
  if (job.state === 'succeeded') return `已更新到 ${job.version}`
  if (job.state === 'failed') return job.error?.summary ?? '更新失败'
  if (job.state === 'cancelled') return '已取消'
  if (job.stage !== 'download') return STAGE_TEXT[job.stage]
  return percent === undefined ? '下载中' : `下载中 ${Math.round(percent)}%`
}

type Props = {
  job: OpencliUpdateJob
  onCancel: () => void
  onRetry: () => void
  onClose: () => void
}

// file-dropzone 上传行样式的更新进度卡片。位置由样式锚定在顶栏这一块的右下。
export function OpencliUpdateCard({ job, onCancel, onRetry, onClose }: Props) {
  const reducedMotion = useReducedMotion()
  const running = job.state === 'running'
  const percent = clampPercent(job.percent)
  const size = job.totalBytes ? `${(job.totalBytes / 1024 ** 2).toFixed(1)} MB` : undefined
  const enter = reducedMotion
    ? { initial: false as const, transition: { duration: 0 } }
    : { initial: { opacity: 0, y: -6, scale: 0.98 }, exit: { opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.15, ease: 'easeIn' as const } }, transition: SPRING }

  return (
    <motion.div
      data-testid="opencli-update-card"
      data-state={job.state}
      className="opencli-update-card"
      animate={{ opacity: 1, y: 0, scale: 1 }}
      {...enter}
    >
      <div className="opencli-update-card__icon">
        <Package size={16} aria-hidden="true" />
        {job.state === 'succeeded' && (
          <motion.span
            data-testid="opencli-update-card-badge"
            className="opencli-update-card__badge"
            initial={reducedMotion ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            transition={reducedMotion ? { duration: 0 } : SPRING}
          >
            <Check size={10} strokeWidth={3} aria-hidden="true" />
          </motion.span>
        )}
      </div>
      <span data-testid="opencli-update-card-announce" role="status" className="sr-only">{statusText(job)}</span>
      <div className="opencli-update-card__text">
        <div className="opencli-update-card__title">OpenCLI {job.version}</div>
        <div data-testid="opencli-update-card-meta" className="opencli-update-card__meta">
          {size && `${size} · `}
          <span data-testid="opencli-update-card-status" className="opencli-update-card__status" title={job.error?.detail}>
            {statusText(job, percent)}
          </span>
        </div>
        <motion.div
          data-testid="opencli-update-card-progress"
          data-open={running}
          className="opencli-update-card__progress"
          aria-hidden={!running}
          initial={false}
          animate={{ height: running ? PROGRESS_OPEN_HEIGHT : 0 }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' }}
        >
          <div
            data-testid="opencli-update-card-bar"
            className="opencli-update-card__bar"
            role="progressbar"
            aria-label={`OpenCLI ${job.version} 更新进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
          >
            <div
              data-testid="opencli-update-card-fill"
              className="opencli-update-card__fill"
              data-shimmer={running && SLOW_STAGES.includes(job.stage)}
              style={{ transform: `scaleX(${percent / 100})` }}
            />
          </div>
        </motion.div>
      </div>
      {(running || job.state === 'failed') && (
        <div className="opencli-update-card__actions">
          {running && (
            <button type="button" aria-label="取消更新" title="取消更新" onClick={onCancel}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
          {job.state === 'failed' && (
            <>
              <button type="button" aria-label="重试" title="重试" onClick={onRetry}>
                <RotateCw size={14} aria-hidden="true" />
              </button>
              <button type="button" aria-label="关闭" title="关闭" onClick={onClose}>
                <X size={14} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}
    </motion.div>
  )
}
