// 「多条模型配置共用同一把 key」的顶部提醒:分组与「不再提醒」的存储。
// 独立 key,值是被关掉的分组 id 数组;不进任何配置快照。
export const SHARED_KEY_REMINDER_DISMISSED_KEY = 'opencli-app:shared-key-reminder-dismissed:v1'

export type SharedKeyGroup = {
  /** 组内通道 id 排序后用 | 连接 —— 成员一变,组 id 随之变化,关掉过的提醒会重新出现。 */
  id: string
  names: string[]
}

type ChannelRef = { id: string; name: string; key_shared_with: string[] }

/** 并出共用同一把 key 的通道组(每组至少两条),按通道首次出现的顺序。只算 liveIds 里还在的通道。 */
export function sharedKeyGroups(channels: ChannelRef[], liveIds: ReadonlySet<string>): SharedKeyGroup[] {
  const seen = new Set<string>()
  const groups: SharedKeyGroup[] = []
  for (const channel of channels) {
    if (seen.has(channel.id) || !liveIds.has(channel.id)) continue
    const members = channels.filter((item) => liveIds.has(item.id)
      && (item.id === channel.id || channel.key_shared_with.includes(item.id)))
    for (const member of members) seen.add(member.id)
    if (members.length < 2) continue
    groups.push({
      id: members.map((member) => member.id).sort().join('|'),
      names: members.map((member) => member.name.trim() || '未命名配置'),
    })
  }
  return groups
}

export function sharedKeyGroupTitle(names: string[]): string {
  const quoted = names.map((name) => `「${name}」`)
  const list = quoted.length === 2
    ? `${quoted[0]}和${quoted[1]}`
    : `${quoted.slice(0, -1).join('、')}和${quoted[quoted.length - 1]}`
  return `${list}用的是同一把 key：中转站可能一次只处理一条；key 被限流或余额不足时，它们会一起不可用。`
}

export function loadSharedKeyReminderDismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SHARED_KEY_REMINDER_DISMISSED_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function saveSharedKeyReminderDismissed(ids: string[]): boolean {
  try {
    localStorage.setItem(SHARED_KEY_REMINDER_DISMISSED_KEY, JSON.stringify(ids))
    return true
  } catch {
    return false   // 配额满 / 隐私模式:本次会话内存态仍有效
  }
}
