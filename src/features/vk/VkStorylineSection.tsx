// 批量任务详情里的「串联分析」区块:展示这批的串联状态,可手动发起,有结果时可打开故事线。
// 引擎没有 /storylines 接口(旧版,404)时整块不渲染。
import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Waypoints } from 'lucide-react'
import { fetchVkStorylines, postVkStoryline } from '../../host/vkClient'
import type { VkStorylineRow } from '../../host/vkClient'
import { HostRequestError } from '../../host/errors'
import { vkErrorText } from './vkErrors'
import { STORYLINE_IN_PROGRESS, storylineStatusText, storylineViewable } from './storyline'

const STORYLINE_POLL_MS = 15_000

function actionError(error: unknown): string {
  return vkErrorText(error, '串联请求失败')
}

export function VkStorylineSection({ batchId, baseUrl, parsedCount, onView }: {
  batchId: string
  baseUrl?: string
  /** 本批已解析成功的视频数。 */
  parsedCount: number
  onView: () => void
}) {
  // null = 还没取到;'unsupported' = 引擎没有串联接口。
  const [rows, setRows] = useState<VkStorylineRow[] | 'unsupported' | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const start = async () => {
    setPending(true)
    setError(null)
    try {
      await postVkStoryline(batchId, baseUrl)
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
            <span>查看故事线</span>
          </button>
        )}
      </div>
    </div>
  )
}
