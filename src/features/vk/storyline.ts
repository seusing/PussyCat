// 故事线串联的前端侧逻辑:状态文案、结果窗口标签、按批取结果。
// 旧版引擎没有 /storylines 接口(404);取结果失败一律当作「没有故事线」,不打扰单视频结果。
import {
  fetchVkStoryline,
  fetchVkStorylines,
  type VkStoryline,
  type VkStorylineMember,
  type VkStorylineResult,
  type VkStorylineRow,
} from '../../host/vkClient'
import type { VkOutputTab } from './VkOutputViewer'

export const STORYLINE_IN_PROGRESS = new Set<string>(['waiting', 'queued', 'running'])

/** 详情里手动发起串联后广播,视频解析页据此开始盯这条串联的结果。 */
export const VK_STORYLINE_STARTED_EVENT = 'vk:storyline-started'

/** 故事线与观点对比的总数;null、旧版引擎缺这个键都按 0 算。 */
export function storylineOutputCount(row: VkStorylineRow): number {
  return (row.storyline_count ?? 0) + (row.comparison_count ?? 0)
}

function settledStatusText(row: VkStorylineRow): string {
  const stories = row.storyline_count ?? 0
  const comparisons = row.comparison_count ?? 0
  const partial = row.status === 'partial'
  let text: string
  if (stories + comparisons === 0) {
    text = partial ? '没有串成故事线，部分内容生成失败' : '这批视频之间没有发现关联，各自保留单独笔记'
  } else {
    text = stories > 0
      ? `已串成 ${stories} 条故事线${comparisons > 0 ? `、${comparisons} 组观点对比` : ''}`
      : `已整理出 ${comparisons} 组观点对比`
    const standalone = row.standalone_count ?? 0
    if (standalone > 0) text += `，${standalone} 个视频未归入`
    if (partial) text += '。部分内容生成失败'
  }
  return row.reason ? `${text}（${row.reason}）` : text
}

export function storylineStatusText(row: VkStorylineRow): string {
  switch (row.status) {
    case 'waiting': return '等本批全部解析完再串联'
    case 'queued': return '排队中'
    case 'running': return '串联中…'
    case 'done':
    case 'partial': return settledStatusText(row)
    case 'skipped': return row.reason ? `可串联的视频不足 2 个（${row.reason}）` : '可串联的视频不足 2 个'
    case 'failed': return '串联失败'
    default: return ''
  }
}

/** 这条记录有可看的故事线或观点对比笔记。 */
export function storylineViewable(row: VkStorylineRow | undefined): row is VkStorylineRow {
  return !!row && (row.status === 'done' || row.status === 'partial') && storylineOutputCount(row) > 0
}

/** 该故事线各集对应成员里最常见的非空作者;并列取最先出现的。 */
function commonAuthor(story: VkStoryline, members: readonly VkStorylineMember[]): string {
  const authorOf = new Map(members.map((member) => [member.job_id, member.author]))
  const counts = new Map<string, number>()
  for (const episode of story.episodes) {
    const author = authorOf.get(episode.job_id)?.trim()
    if (author) counts.set(author, (counts.get(author) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [author, count] of counts) {
    if (count > bestCount) { best = author; bestCount = count }
  }
  return best
}

/** 先是各条故事线,再是各组观点对比。 */
export function storylineTabs(result: VkStorylineResult): VkOutputTab[] {
  const storyTabs = result.storylines.map((story) => {
    const author = commonAuthor(story, result.members)
    const first = [...story.episodes].sort((left, right) => left.order - right.order)[0]
    return {
      id: `storyline:${result.storyline_id}:${story.id}`,
      label: `故事线 · ${story.title}`,
      content: story.markdown,
      libraryTitle: author ? `${author} · ${story.title}` : story.title,
      ...(first?.url ? { source: first.url } : {}),
      ...(story.terms?.length ? { terms: story.terms } : {}),
    }
  })
  const comparisonTabs = (result.comparisons ?? []).map((comparison) => {
    const label = `观点对比 · ${comparison.title}`
    return {
      id: `comparison:${result.storyline_id}:${comparison.id}`,
      label,
      content: comparison.markdown,
      libraryTitle: label,
      ...(comparison.terms?.length ? { terms: comparison.terms } : {}),
    }
  })
  return [...storyTabs, ...comparisonTabs]
}

/** 该批最新一次串联的故事线与观点对比标签;没有、没做完或取不到都返回空数组。 */
export async function loadStorylineTabs(batchId: string, baseUrl?: string): Promise<VkOutputTab[]> {
  try {
    const latest = (await fetchVkStorylines(batchId, baseUrl))[0]
    if (!storylineViewable(latest)) return []
    const view = await fetchVkStoryline(latest.storyline_id, baseUrl)
    return view.result ? storylineTabs(view.result) : []
  } catch {
    return []
  }
}
