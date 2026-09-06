import type { CommandManifest } from './types'
import { commandsForSite, SUPPORTED_SITES, visibleCommands } from './supportedSites'

const command = (site: string, name: string): CommandManifest => ({
  command: `${site}/${name}`,
  site,
  name,
  description: '',
  access: 'read',
  browser: false,
  args: [],
})

test('xiaohongshu 只显示合并后的 saved 命令', () => {
  const xiaohongshu = SUPPORTED_SITES.find((site) => site.id === 'xiaohongshu')!
  const commands = [command('xiaohongshu', 'saved'), command('xiaohongshu', 'collections')]

  expect(commandsForSite(commands, xiaohongshu).map((item) => item.name)).toEqual(['saved'])
  expect(visibleCommands(commands).map((item) => item.name)).toEqual(['saved'])
})

test('产品目录的其他站点过滤行为不变', () => {
  const commands = [
    command('xiaohongshu', 'saved'),
    command('xiaohongshu', 'collections'),
    command('twitter', 'timeline'),
    command('youtube', 'subscriptions'),
    command('unsupported', 'example'),
  ]

  expect(visibleCommands(commands).map((item) => item.command)).toEqual([
    'xiaohongshu/saved',
    'twitter/timeline',
    'youtube/subscriptions',
  ])
})
