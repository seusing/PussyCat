import { groupBySite, searchCommands, loadCatalog } from './catalog'
import type { CommandManifest } from './types'

const c = (site: string, name: string, extra: Partial<CommandManifest> = {}): CommandManifest => ({
  command: `${site}/${name}`, site, name, description: '', access: 'read', browser: false, args: [], ...extra,
})

const cmds = [
  // 插入顺序刻意与字母序相反（xiaohongshu 在前、12306 在后），
  // 使 groupBySite 的排序测试无法靠 Map 插入顺序侥幸通过。
  c('xiaohongshu', 'download', { description: '下载笔记图片和视频', aliases: ['dl'] }),
  c('12306', 'login', { description: 'Open 12306 login' }),
  c('12306', 'orders'),
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

// assertSnapshot 运行时 schema 校验（经 loadCatalog 间接验证，不单独导出内部函数）
test('loadCatalog：http 非 ok 时抛错并带状态码', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
  await expect(loadCatalog()).rejects.toThrow(/404/)
})

test('loadCatalog：schemaVersion 不支持时抛错', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 2, commands: [] }) })))
  await expect(loadCatalog()).rejects.toThrow(/schemaVersion/)
})

test('loadCatalog：commands 非数组时抛错', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, commands: {} }) })))
  await expect(loadCatalog()).rejects.toThrow(/commands/)
})

test('loadCatalog：命令缺字段时抛错', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ schemaVersion: 1, commands: [{ command: 'x/y' }] }),  // 缺 site/name/access/args
  })))
  await expect(loadCatalog()).rejects.toThrow(/字段缺失/)
})

test('loadCatalog：合法 snapshot 正常返回', async () => {
  const snap = { schemaVersion: 1, generatedAt: 0, opencliVersion: '', source: '', listSha256: '', manifestSha256: '', commands: cmds }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => snap })))
  await expect(loadCatalog()).resolves.toEqual(snap)
})
