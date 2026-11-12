// 笔记里的预测核验行是生成笔记那一刻定格的;打开笔记时向引擎要一次用最新行情重算后的行,
// 按旧行文字换进 Markdown,之后照常走 NoteEvidence 的解析(状态徽标随新状态变色)。
// 请求失败或没有匹配的行时显示原文,不报错,也不阻塞笔记显示。
import { useEffect, useState } from 'react'
import { fetchVkForecasts } from '../../host/vkClient'

const FORECAST_PREFIX = '预测核验 ·'

/** 把笔记里生成时的核验行换成重算后的行;lines 里没有的行原样保留。 */
export function applyForecastLines(markdown: string, lines: Readonly<Record<string, string>> | null): string {
  if (!lines) return markdown
  let result = markdown
  for (const [stale, fresh] of Object.entries(lines)) result = result.split(stale).join(fresh)
  return result
}

/**
 * 笔记含预测核验行且知道它属于哪个任务时,每个任务取一次重算结果。
 * 还没取回、取失败、笔记里没有预测核验行时返回 null。
 */
export function useRefreshedForecasts(
  jobId: string | undefined,
  baseUrl: string | undefined,
  markdown: string,
): Record<string, string> | null {
  const [loaded, setLoaded] = useState<{ key: string; lines: Record<string, string> } | null>(null)
  const key = jobId ? JSON.stringify([baseUrl, jobId]) : null
  const wanted = key !== null && markdown.includes(FORECAST_PREFIX)

  useEffect(() => {
    if (!wanted || !jobId || !key) return
    let current = true
    void fetchVkForecasts(jobId, baseUrl)
      .then((lines) => { if (current) setLoaded({ key, lines }) })
      .catch(() => {})
    return () => { current = false }
  }, [wanted, jobId, baseUrl, key])

  return wanted && loaded?.key === key ? loaded.lines : null
}
