import type { CommandManifest } from '../../data/types'

// 站点命令列表的分组:常用 / 读取 / 写入。
//
// 「常用」是按目录人工挑的只读命令(每站点 3–6 个),顺序即展示顺序,挑选标准是
// 「采集灵感」最常用到:搜索、看内容详情、看评论/字幕、翻某个账号的内容、翻自己的收藏。
// 登录检查用的 whoami、需要先查 ID 才能用的命令不在其中。
// 读写以 manifest 的 access 为准(与列表里的「读取/写入」标记同源);access 一旦变成 write,
// 即使还在这张表里也不会出现在「常用」里。
export const COMMON_COMMAND_KEYS: readonly string[] = [
  'xiaohongshu/search',
  'xiaohongshu/note',
  'xiaohongshu/comments',
  'xiaohongshu/user-posts',
  'xiaohongshu/feed',
  'xiaohongshu/saved',
  'twitter/search',
  'twitter/timeline',
  'twitter/tweets',
  'twitter/thread',
  'twitter/bookmarks',
  'twitter/profile',
  'youtube/search',
  'youtube/video',
  'youtube/transcript',
  'youtube/comments',
  'youtube/channel',
  'youtube/subscriptions',
  'bilibili/search',
  'bilibili/video',
  'bilibili/summary',
  'bilibili/subtitle',
  'bilibili/comments',
  'bilibili/hot',
]

export type CommandGroups = {
  common: CommandManifest[]
  read: CommandManifest[]
  write: CommandManifest[]
}

/** 把一个站点的命令分成三组。「读取」不含已在「常用」里的命令,同一条命令只出现一次。 */
export function groupCommands(commands: CommandManifest[]): CommandGroups {
  const rank = new Map(COMMON_COMMAND_KEYS.map((key, index) => [key, index]))
  const common = commands
    .filter((command) => command.access !== 'write' && rank.has(command.command))
    .sort((left, right) => rank.get(left.command)! - rank.get(right.command)!)
  const picked = new Set(common.map((command) => command.command))
  return {
    common,
    read: commands.filter((command) => command.access !== 'write' && !picked.has(command.command)),
    write: commands.filter((command) => command.access === 'write'),
  }
}
