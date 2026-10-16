// 批量任务详情里的「串联分析」区块:展示这批的串联状态,可手动发起,有结果时可打开故事线或观点对比;
// 串联已开始运行时可展开「串联过程」,逐步看到每一步由谁回答。
// 引擎没有 /storylines 接口(旧版,404)时整块不渲染。
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { BookOpen, ChevronDown, Waypoints } from 'lucide-react'
import { fetchVkJob, fetchVkStorylines, postVkStoryline } from '../../host/vkClient'
import type { VkJobView, VkStorylineRow } from '../../host/vkClient'
import { HostRequestError } from '../../host/errors'
import { vkErrorText } from './vkErrors'
import { VkFailureNote } from './VkFailureNote'
import { STORYLINE_IN_PROGRESS, VK_STORYLINE_STARTED_EVENT, storylineStatusText, storylineViewable } from './storyline'

const STORYLINE_POLL_MS = 15_000
const RUN_POLL_MS = 1_500

function actionError(error: unknown): string {
  return vkErrorText(error, '串联请求失败')
}

export function VkStorylineSection({ batchId, baseUrl, parsedCount, onView, renderRunProgress }: {
  batchId: string
  baseUrl?: string
  /** 本批已解析成功的视频数。 */
  parsedCount: number
  onView: () => void
  /** 渲染串联运行的流程列表;不传就不提供「串联过程」。 */
  renderRunProgress?: (run: VkJobView) => ReactNode
}) {
  // null = 还没取到;'unsupported' = 引擎没有串联接口。
  const [rows, setRows] = useState<VkStorylineRow[] | 'unsupported' | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runOpen, setRunOpen] = useState(false)
  // 带上 runId:串联换了一次运行时,上一次的进度和错误不会冒充这一次的。
  const [runState, setRunState] = useState<{ runId: string; job: VkJobView | null; error: string | null } | null>(null)

  const refresh = useCallback(async () => {
    try {
      setRows(await fetchVkStorylines(batchId, baseUrl))
      setError(null)
    } catch (loadError) {
      if (loadError instanceof HostRequestError && loadError.status === 404) {
        setRows('unsupported')
        return
      }
      setRows((current) => current ?? [])
      setError(actionError(loadError))
    }
  }, [batchId, baseUrl])

  useEffect(() => { void refresh() }, [refresh])

  const inProgress = Array.isArray(rows) && rows.some((row) => STORYLINE_IN_PROGRESS.has(row.status))
  useEffect(() => {
    if (!inProgress) return undefined
    const timer = window.setInterval(() => { void refresh() }, STORYLINE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [inProgress, refresh])

  const latestRow = Array.isArray(rows) ? rows[0] : undefined
  const runId = latestRow?.run_id ?? null
  const runShown = runOpen && !!runId && !!renderRunProgress
  const runView = runState?.runId === runId ? runState : null
  const runPolling = runShown
    && ((!!latestRow && STORYLINE_IN_PROGRESS.has(latestRow.status)) || runView?.job?.status === 'running')

  const loadRun = useCallback(async () => {
    if (!runId) return
    try {
      setRunState({ runId, job: await fetchVkJob(`run:${runId}`, baseUrl), error: null })
    } catch (loadError) {
      setRunState((current) => ({
        runId,
        job: current?.runId === runId ? current.job : null,
        error: vkErrorText(loadError, '串联过程读取失败'),
      }))
    }
  }, [runId, baseUrl])

  // 展开后才请求;串联换了运行或这一行的状态变了,重新取一次。
  const latestStatus = latestRow?.status
  useEffect(() => {
    if (runShown) void loadRun()
  }, [runShown, loadRun, latestStatus])

  useEffect(() => {
    if (!runPolling) return undefined
    const timer = window.setInterval(() => { void loadRun() }, RUN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [runPolling, loadRun])

  const start = async () => {
    setPending(true)
    setError(null)
    try {
      await postVkStoryline(batchId, baseUrl)
      window.dispatchEvent(new CustomEvent(VK_STORYLINE_STARTED_EVENT))
      await refresh()
    } catch (startError) {
      setError(actionError(startError))
    } finally {
      setPending(false)
    }
  }

  if (!Array.isArray(rows)) return null
  const latest = rows[0]
  const startTitle = inProgress
    ? '本批已有串联在进行中'
    : parsedCount < 2 ? '至少需要 2 个解析成功的视频' : undefined

  return (
    <div className="vk-task-detail-section vk-storyline-section" data-testid="vk-storyline-section">
      <h3>串联分析</h3>
      {latest && (
        <p className="vk-storyline-status" data-testid="vk-storyline-status" data-status={latest.status}>
          {storylineStatusText(latest)}
        </p>
      )}
      {latest?.status === 'failed' && latest.error && <VkFailureNote raw={latest.error} />}
      {error && <p className="vk-storyline-error" role="alert">{error}</p>}
      <div className="vk-storyline-actions">
        <button
          type="button"
          data-testid="vk-storyline-start"
          disabled={pending || inProgress || parsedCount < 2}
          title={startTitle}
          onClick={() => { void start() }}
        >
          <Waypoints size={14} aria-hidden="true" />
          <span>串联分析</span>
        </button>
        {storylineViewable(latest) && (
          <button type="button" data-testid="vk-storyline-view" onClick={onView}>
            <BookOpen size={14} aria-hidden="true" />
            <span>{(latest.storyline_count ?? 0) > 0 ? '查看故事线' : '查看观点对比'}</span>
          </button>
        )}
      </div>
      {runId && renderRunProgress && (
        <div className="vk-storyline-run">
          <button
            type="button"
            className="vk-storyline-run-toggle"
            data-testid="vk-storyline-run-toggle"
            aria-expanded={runOpen}
            onClick={() => setRunOpen((open) => !open)}
          >
            <ChevronDown className="vk-storyline-run-chevron" size={14} aria-hidden="true" />
            <span>串联过程</span>
          </button>
          {runOpen && (
            <div className="vk-storyline-run-body" data-testid="vk-storyline-run">
              {runView?.job && renderRunProgress(runView.job)}
              {!runView?.job && !runView?.error && <p className="vk-storyline-run-note" role="status">正在读取串联过程…</p>}
              {runView?.error && <p className="vk-storyline-error" role="alert">{runView.error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
