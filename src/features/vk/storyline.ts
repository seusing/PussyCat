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

export function storylineStatusText(row: VkStorylineRow): string {
  switch (row.status) {
    case 'waiting': return '等本批全部解析完再串联'
    case 'queued': return '排队中'
    case 'running': return '串联中…'
    case 'done':
    case 'partial': {
      const text = `已串成 ${row.storyline_count ?? 0} 条故事线，${row.standalone_count ?? 0} 个视频未归入`
      return row.status === 'partial' ? `${text}。部分内容生成失败` : text
    }
    case 'skipped': return row.reason ? `可串联的视频不足 2 个（${row.reason}）` : '可串联的视频不足 2 个'
    case 'failed': return '串联失败'
    default: return ''
  }
}

/** 这条记录有可看的故事线笔记。 */
export function storylineViewable(row: VkStorylineRow | undefined): row is VkStorylineRow {
  return !!row && (row.status === 'done' || row.status === 'partial') && (row.storyline_count ?? 0) > 0
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

export function storylineTabs(result: VkStorylineResult): VkOutputTab[] {
  return result.storylines.map((story) => {
    const author = commonAuthor(story, result.members)
    const first = [...story.episodes].sort((left, right) => left.order - right.order)[0]
    return {
      id: `storyline:${result.storyline_id}:${story.id}`,
      label: `故事线 · ${story.title}`,
      content: story.markdown,
      libraryTitle: author ? `${author} · ${story.title}` : story.title,
      ...(first?.url ? { source: first.url } : {}),
    }
  })
}

/** 该批最新一次串联的故事线标签;没有、没做完或取不到都返回空数组。 */
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
