import { describe, expect, it } from 'vitest'
import {
  buildInspirationBackup,
  mergeInspirationLibrary,
  parseInspirationBackup,
  readBackupFile,
} from './inspirationBackup'
import type { InspirationFolder, InspirationItem, InspirationLibrary } from './inspirationLibrary'

function item(id: string, patch: Partial<InspirationItem> = {}): InspirationItem {
  return { id, title: `标题 ${id}`, content: `内容 ${id}`, kind: 'note', format: 'md', folderId: null, createdAt: 1, updatedAt: 1, ...patch }
}

function folder(id: string, patch: Partial<InspirationFolder> = {}): InspirationFolder {
  return { id, name: `文件夹 ${id}`, createdAt: 1, parentId: null, ...patch }
}

function library(items: InspirationItem[] = [], folders: InspirationFolder[] = []): InspirationLibrary {
  return { version: 1, folders, items }
}

describe('导出', () => {
  it('文件名带本地日期,内容带版本字段和整份库', () => {
    const source = library([item('a')], [folder('f')])
    const { fileName, content } = buildInspirationBackup(source, new Date(2026, 8, 5, 10, 30))

    expect(fileName).toBe('爪爪灵感库-20260905.json')
    const parsed = JSON.parse(content)
    expect(parsed).toMatchObject({ backupVersion: 1, library: source })
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('导出的文件可以原样导入', () => {
    const source = library([item('a', { source: 'https://example.com/a' })], [folder('f')])
    expect(parseInspirationBackup(buildInspirationBackup(source).content)).toEqual({ library: source, invalid: 0 })
  })
})

describe('解析备份文件', () => {
  it('也接受直接是库本体的文件', () => {
    const source = library([item('a')])
    expect(parseInspirationBackup(JSON.stringify(source)).library).toEqual(source)
  })

  it('丢弃格式不合格的条目并计数,修复指向不存在文件夹的引用', () => {
    const parsed = parseInspirationBackup(JSON.stringify(library(
      [item('ok', { folderId: 'missing' }), { id: 'broken' } as InspirationItem],
      [folder('f'), { id: 'no-name' } as InspirationFolder],
    )))

    expect(parsed.invalid).toBe(2)
    expect(parsed.library.items.map((entry) => entry.id)).toEqual(['ok'])
    expect(parsed.library.items[0].folderId).toBeNull()
    expect(parsed.library.folders.map((entry) => entry.id)).toEqual(['f'])
  })

  it('格式不对时给出明确错误', () => {
    expect(() => parseInspirationBackup('不是 json')).toThrow('这不是有效的 JSON 文件')
    expect(() => parseInspirationBackup('[]')).toThrow('这不是爪爪灵感库的备份文件')
    expect(() => parseInspirationBackup('{"hello":"world"}')).toThrow('这不是爪爪灵感库的备份文件')
    expect(() => parseInspirationBackup('{"version":1,"folders":[]}')).toThrow('这不是爪爪灵感库的备份文件')
    expect(() => parseInspirationBackup('{"version":2,"folders":[],"items":[]}')).toThrow('这不是爪爪灵感库的备份文件')
    expect(() => parseInspirationBackup('{"backupVersion":2,"library":{"version":1,"folders":[],"items":[]}}')).toThrow('版本不受支持')
  })

  it('readBackupFile 读出文件文本', async () => {
    const file = new File(['{"a":"中文"}'], 'backup.json', { type: 'application/json' })
    await expect(readBackupFile(file)).resolves.toBe('{"a":"中文"}')
  })
})

describe('合并', () => {
  it('同 id 的条目和文件夹跳过,保留现有的', () => {
    const current = library([item('a', { content: '现有' })], [folder('f', { name: '现有文件夹' })])
    const incoming = library(
      [item('a', { content: '备份里的' }), item('b')],
      [folder('f', { name: '备份里的文件夹' }), folder('g')],
    )

    const { library: merged, imported, skipped } = mergeInspirationLibrary(current, incoming)

    expect(imported).toBe(2)
    expect(skipped).toBe(2)
    expect(merged.items.map((entry) => [entry.id, entry.content])).toEqual([['a', '现有'], ['b', '内容 b']])
    expect(merged.folders.map((entry) => [entry.id, entry.name])).toEqual([['f', '现有文件夹'], ['g', '文件夹 g']])
  })

  it('同类型同网址来源的条目视为重复', () => {
    const current = library([item('a', { kind: 'article', source: 'https://mp.weixin.qq.com/s/x' })])
    const incoming = library([
      item('b', { kind: 'article', source: 'https://mp.weixin.qq.com/s/x' }),
      item('c', { kind: 'video', source: 'https://mp.weixin.qq.com/s/x' }),
      item('d', { kind: 'article', source: 'https://mp.weixin.qq.com/s/y' }),
    ])

    const { library: merged, imported, skipped } = mergeInspirationLibrary(current, incoming)

    expect(skipped).toBe(1)
    expect(imported).toBe(2)
    expect(merged.items.map((entry) => entry.id)).toEqual(['a', 'c', 'd'])
  })

  it('来源不是网址的条目(站点名、任务名)不按来源判重', () => {
    const current = library([item('a', { kind: 'source', source: 'xiaohongshu' })])
    const incoming = library([item('b', { kind: 'source', source: 'xiaohongshu' })])

    expect(mergeInspirationLibrary(current, incoming)).toMatchObject({ imported: 1, skipped: 0 })
  })

  it('备份文件内部共用同一网址的条目都会导入,导入到空库等于原样恢复', () => {
    const incoming = library([
      item('a', { kind: 'video', source: 'https://example.com/v' }),
      item('b', { kind: 'video', source: 'https://example.com/v' }),
      item('c', { kind: 'source', source: 'xiaohongshu' }),
      item('d', { kind: 'source', source: 'xiaohongshu' }),
    ], [folder('f'), folder('g', { parentId: 'f' })])

    const { library: merged, imported, skipped } = mergeInspirationLibrary(library(), incoming)

    expect(merged).toEqual(incoming)
    expect(imported).toBe(6)
    expect(skipped).toBe(0)
  })

  it('再导入同一份文件全部跳过,库不变', () => {
    const incoming = library([item('a', { kind: 'article', source: 'https://example.com/a' }), item('b')], [folder('f')])
    const first = mergeInspirationLibrary(library(), incoming)
    const second = mergeInspirationLibrary(first.library, incoming)

    expect(second).toMatchObject({ imported: 0, skipped: 3 })
    expect(second.library).toEqual(first.library)
  })

  it('子文件夹挂到被保留的现有同 id 文件夹下', () => {
    const current = library([], [folder('parent', { name: '现有父级' })])
    const incoming = library([item('a', { folderId: 'parent' })], [folder('parent', { name: '备份父级' }), folder('child', { parentId: 'parent' })])

    const { library: merged } = mergeInspirationLibrary(current, incoming)

    expect(merged.folders.map((entry) => [entry.id, entry.name, entry.parentId])).toEqual([
      ['parent', '现有父级', null],
      ['child', '文件夹 child', 'parent'],
    ])
    expect(merged.items[0].folderId).toBe('parent')
  })
})
