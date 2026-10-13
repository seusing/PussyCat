// 「多条模型配置共用同一把 key」的顶部提醒:识别与分组。

export type SharedKeyGroup = {
  /** 组内通道 id 排序后用 | 连接 —— 成员一变,组 id 随之变化。 */
  id: string
  /** 组内通道 id,按通道顺序。 */
  ids: string[]
  names: string[]
}

type ChannelRef = {
  id: string
  name: string
  key_env: string
  key_masked: string
  key_shared_with?: string[]
}

// 引擎的打码规则:key 长于 12 位时是前 7 位 + 10 个 • + 后 4 位,否则是前 3 位 + 8 个 •。
// 短 key 打码后只剩 3 位可辨,容易撞,不用它判断。
function isLongMaskedKey(masked: string): boolean {
  return masked !== '' && !masked.endsWith('•')
}

/** 与 channel 共用同一把 key 的其他通道 id,按通道顺序。
 *  新版引擎直接给 key_shared_with 就用它;旧版没有这个字段,按「key_env 相同」或「长 key 的打码相同」推断。 */
export function sharedKeyPeers(channel: ChannelRef, channels: ChannelRef[]): string[] {
  if (channel.key_shared_with) return channel.key_shared_with
  return channels
    .filter((item) => item.id !== channel.id && (
      (channel.key_env !== '' && item.key_env === channel.key_env)
      || (isLongMaskedKey(channel.key_masked) && item.key_masked === channel.key_masked)
    ))
    .map((item) => item.id)
}

/** 并出共用同一把 key 的通道组(每组至少两条),按通道首次出现的顺序。只算 liveIds 里还在的通道。 */
export function sharedKeyGroups(channels: ChannelRef[], liveIds: ReadonlySet<string>): SharedKeyGroup[] {
  const live = channels.filter((channel) => liveIds.has(channel.id))
  const seen = new Set<string>()
  const groups: SharedKeyGroup[] = []
  for (const channel of live) {
    if (seen.has(channel.id)) continue
    const peers = sharedKeyPeers(channel, live)
    const members = live.filter((item) => item.id === channel.id || peers.includes(item.id))
    for (const member of members) seen.add(member.id)
    if (members.length < 2) continue
    const ids = members.map((member) => member.id)
    groups.push({
      id: [...ids].sort().join('|'),
      ids,
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
