import { groupBySite, searchCommands } from './catalog'
import type { CommandManifest } from './types'

const c = (site: string, name: string, extra: Partial<CommandManifest> = {}): CommandManifest => ({
  command: `${site}/${name}`, site, name, description: '', access: 'read', browser: false, args: [], ...extra,
})

const cmds = [
  c('12306', 'login', { description: 'Open 12306 login' }),
  c('12306', 'orders'),
  c('xiaohongshu', 'download', { description: '下载笔记图片和视频', aliases: ['dl'] }),
]

test('groupBySite 按站点分组并按站点名排序', () => {
  const groups = groupBySite(cmds)
  expect(groups.map((g) => g.site)).toEqual(['12306', 'xiaohongshu'])
  expect(groups[0].commands).toHaveLength(2)
})

test('searchCommands 匹配 name/description/site/alias', () => {
  expect(searchCommands(cmds, 'download').map((x) => x.command)).toEqual(['xiaohongshu/download'])
  expect(searchCommands(cmds, '下载').map((x) => x.command)).toEqual(['xiaohongshu/download'])
  expect(searchCommands(cmds, 'dl').map((x) => x.command)).toEqual(['xiaohongshu/download'])
  expect(searchCommands(cmds, '12306').length).toBe(2)
})

test('searchCommands 空查询返回全部', () => {
  expect(searchCommands(cmds, '  ').length).toBe(3)
})
