import { stripBom, mergeManifestFields, readListOutput, commandsFromList } from './normalize.mjs'
import type { CommandManifest } from '../data/types'

test('stripBom 去除开头 BOM', () => {
  expect(stripBom('﻿[]')).toBe('[]')
  expect(stripBom('[]')).toBe('[]')
})

test('mergeManifestFields 按 site+name 补 navigateBefore/defaultWindowMode/type/modulePath', () => {
  const list: CommandManifest[] = [
    { command: '12306/login', site: '12306', name: 'login', description: '', access: 'write', browser: true, args: [] },
  ]
  const manifest = [
    { site: '12306', name: 'login', navigateBefore: false, defaultWindowMode: 'foreground', type: 'js', modulePath: '12306/auth.js' },
    { site: 'other', name: 'x', navigateBefore: true },
  ]
  const merged = mergeManifestFields(list, manifest)
  expect(merged[0].navigateBefore).toBe(false)
  expect(merged[0].defaultWindowMode).toBe('foreground')
  expect(merged[0].type).toBe('js')
  expect(merged[0].modulePath).toBe('12306/auth.js')
})

test('mergeManifestFields 对没有 manifest 对应项的命令保持原样', () => {
  const list: CommandManifest[] = [
    { command: 'baidubaike/search', site: 'baidubaike', name: 'search', description: '', access: 'read', browser: true, args: [] },
  ]
  const merged = mergeManifestFields(list, [])
  expect(merged[0].navigateBefore).toBeUndefined()
  expect(merged[0].site).toBe('baidubaike')
})

test('mergeManifestFields 命令自身已有字段时优先保留命令值，不被 manifest 覆盖', () => {
  const list: CommandManifest[] = [
    { command: 'x/y', site: 'x', name: 'y', description: '', access: 'read', browser: false, args: [], navigateBefore: true, type: 'js' },
  ]
  const manifest = [
    { site: 'x', name: 'y', navigateBefore: false, type: 'other' },
  ]
  const merged = mergeManifestFields(list, manifest)
  expect(merged[0].navigateBefore).toBe(true)
  expect(merged[0].type).toBe('js')
})

const envelopePage = (commands: object[], nextOffset: number | null, total = 5) =>
  JSON.stringify({ ok: true, data: { commands, total, nextOffset } })

test('readListOutput 1.8.8:完整数组一次读完', async () => {
  const calls: string[][] = []
  const raw = JSON.stringify([{ command: 'a/b', site: 'a', name: 'b' }])
  const output = await readListOutput(async (extraArgs) => { calls.push(extraArgs); return raw })
  expect(output).toEqual({ envelope: false, list: [{ command: 'a/b', site: 'a', name: 'b' }], raw })
  expect(calls).toEqual([[]])
})

test('readListOutput 2.0:首页不带参数,之后按 nextOffset 用 --limit 100 翻到 null', async () => {
  const pages: Record<string, string> = {
    '': envelopePage([{ command: 'a x' }, { command: 'a y' }], 2),
    '100:2': envelopePage([{ command: 'b z' }], 3),
    '100:3': envelopePage([{ command: 'c w' }], null),
  }
  const calls: string[][] = []
  const output = await readListOutput(async (extraArgs) => {
    calls.push(extraArgs)
    return pages[extraArgs.length ? `${extraArgs[1]}:${extraArgs[3]}` : '']
  })
  expect(calls).toEqual([[], ['--limit', '100', '--offset', '2'], ['--limit', '100', '--offset', '3']])
  expect(output.envelope).toBe(true)
  expect(output.list.map((item) => item.command)).toEqual(['a x', 'a y', 'b z', 'c w'])
})

test('readListOutput 2.0:带 BOM 的输出也能读', async () => {
  const output = await readListOutput(async () => `﻿${envelopePage([{ command: 'a x' }], null)}`)
  expect(output.list).toHaveLength(1)
})

test('readListOutput:不是 JSON、不是数组也不是成功外壳时报错', async () => {
  await expect(readListOutput(async () => 'oops')).rejects.toThrow('opencli list output is not valid JSON')
  await expect(readListOutput(async () => '{"ok":false,"error":{"code":"X"}}')).rejects.toThrow('opencli list output is not an array')
  await expect(readListOutput(async () => '"text"')).rejects.toThrow('opencli list output is not an array')
})

test('readListOutput 2.0:nextOffset 不前进时报错而不是死循环', async () => {
  await expect(readListOutput(async () => envelopePage([{ command: 'a x' }], 0))).rejects.toThrow('did not advance')
})

test('commandsFromList 按输出形状选路径:1.8.8 补字段,2.0 从 manifest 构造', () => {
  const manifest = [{ site: 'a', name: 'b', type: 'js', modulePath: 'a/b.js', access: 'read', args: [] }]
  const legacy = commandsFromList(
    { envelope: false, list: [{ command: 'a/b', site: 'a', name: 'b', description: 'd', access: 'read', args: [] }] },
    manifest,
  )
  expect(legacy[0]).toMatchObject({ command: 'a/b', type: 'js', modulePath: 'a/b.js' })
  const modern = commandsFromList({ envelope: true, list: [{ command: 'a b', description: 'd2', access: 'read' }] }, manifest)
  expect(modern[0]).toMatchObject({ command: 'a/b', site: 'a', name: 'b', description: 'd2', aliases: [], type: 'js' })
})
