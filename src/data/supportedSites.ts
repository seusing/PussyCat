import type { CommandManifest } from './types'

export type SupportedSite = {
  id: string
  keys: string[]
  label: string
  eyebrow: string
  logo: string
  tint: string
  description: string
}

export const SUPPORTED_SITES: SupportedSite[] = [
  {
    id: 'wechat',
    keys: ['wechat-channels', 'weixin'],
    label: '微信',
    eyebrow: 'WeChat',
    logo: '/site-logos/wechat.svg',
    tint: '#07c160',
    description: '公众号与视频号内容、草稿和账号状态',
  },
  {
    id: 'x',
    keys: ['twitter'],
    label: 'X',
    eyebrow: 'X / Twitter',
    logo: '/site-logos/x.svg',
    tint: '#f4f4f5',
    description: '时间线、搜索、书签和公开资料',
  },
  {
    id: 'xiaohongshu',
    keys: ['xiaohongshu'],
    label: '小红书',
    eyebrow: 'Xiaohongshu',
    logo: '/site-logos/xiaohongshu.svg',
    tint: '#ff2442',
    description: '笔记、推荐流、收藏和创作者数据',
  },
  {
    id: 'youtube',
    keys: ['youtube'],
    label: 'YouTube',
    eyebrow: 'YouTube',
    logo: '/site-logos/youtube.svg',
    tint: '#ff0033',
    description: '视频、频道、字幕和订阅内容',
  },
  {
    id: 'bilibili',
    keys: ['bilibili'],
    label: 'B站',
    eyebrow: 'Bilibili',
    logo: '/site-logos/bilibili.svg',
    tint: '#00aeec',
    description: '视频、番剧、收藏和账号动态',
  },
]

export function siteForCommand(site: string): SupportedSite | undefined {
  return SUPPORTED_SITES.find((item) => item.keys.includes(site))
}

export function commandsForSite(commands: CommandManifest[], site: SupportedSite): CommandManifest[] {
  return commands.filter((command) => site.keys.includes(command.site))
}

/**
 * Keep the product UI intentionally focused. Small fixture catalogs used by tests
 * may contain synthetic site keys, while the product catalog carries the full
 * supported-site set.
 */
export function visibleCommands(commands: CommandManifest[]): CommandManifest[] {
  const presentProductSites = new Set(
    commands.map((command) => siteForCommand(command.site)?.id).filter((id): id is string => !!id),
  )
  return presentProductSites.size >= 3
    ? commands.filter((command) => !!siteForCommand(command.site))
    : commands
}
