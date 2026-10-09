import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { groupCommands } from './commandGroups'
import { visibleCommands } from '../../data/supportedSites'
import type { CommandManifest } from '../../data/types'

const snapshot = JSON.parse(readFileSync(resolve(process.cwd(), 'public/catalog.snapshot.json'), 'utf8')) as { commands: CommandManifest[] }
const FOUR_SITES = ['twitter', 'xiaohongshu', 'youtube', 'bilibili']
const visible = visibleCommands(snapshot.commands).filter((command) => FOUR_SITES.includes(command.site))

describe('命令分组:常用 / 读取 / 写入', () => {
  const bySite = (site: string) => visible.filter((command) => command.site === site)

  test.each(FOUR_SITES)('%s 的「常用」是 3–6 个目录里真实存在的只读命令', (site) => {
    const { common } = groupCommands(bySite(site))
    expect(common.length).toBeGreaterThanOrEqual(3)
    expect(common.length).toBeLessThanOrEqual(6)
    for (const command of common) expect(command.access, command.command).toBe('read')
  })

  test.each(FOUR_SITES)('%s:三组不重不漏,写入组正好是 access=write 的命令', (site) => {
    const all = bySite(site)
    const groups = groupCommands(all)
    const merged = [...groups.common, ...groups.read, ...groups.write].map((command) => command.command)
    expect(merged.sort()).toEqual(all.map((command) => command.command).sort())
    expect(new Set(merged).size).toBe(merged.length)
    expect(groups.write.map((command) => command.command).sort())
      .toEqual(all.filter((command) => command.access === 'write').map((command) => command.command).sort())
    expect(groups.read.every((command) => command.access === 'read')).toBe(true)
  })

  test('「常用」按挑选顺序排列,不受目录顺序影响', () => {
    const { common } = groupCommands([...bySite('bilibili')].reverse())
    expect(common.map((command) => command.name)).toEqual(['search', 'video', 'summary', 'subtitle', 'comments', 'hot'])
  })

  test('manifest 把某条「常用」命令改成 write 之后,它自动落进「写入」', () => {
    const search = { ...bySite('twitter').find((command) => command.name === 'search')!, access: 'write' as const }
    const groups = groupCommands([search])
    expect(groups.common).toEqual([])
    expect(groups.write).toEqual([search])
  })
})
