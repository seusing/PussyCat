import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'

const fixtures = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function applyTwice(entries) {
  const target = mkdtempSync(join(tmpdir(), 'opencli-override-'))
  fixtures.push(target)
  mkdirSync(join(target, 'clis', 'xiaohongshu'), { recursive: true })
  writeFileSync(join(target, 'cli-manifest.json'), JSON.stringify(entries))
  const script = join(process.cwd(), 'scripts', 'apply-opencli-overrides.mjs')
  execFileSync(process.execPath, [script, `--target=${target}`])
  execFileSync(process.execPath, [script, `--target=${target}`])
  return JSON.parse(readFileSync(join(target, 'cli-manifest.json'), 'utf8'))
}

const upstream = () => [
  { site: 'xiaohongshu', name: 'saved', args: [] },
  { site: 'xiaohongshu', name: 'search', args: [{ name: 'query', type: 'str', required: true, positional: true }], columns: ['rank', 'title', 'author', 'likes', 'published_at', 'url'] },
  { site: 'xiaohongshu', name: 'user', args: [] },
]

test('saved 幂等追加收藏夹列表开关', () => {
  const manifest = applyTwice(upstream())
  const saved = manifest.find((entry) => entry.site === 'xiaohongshu' && entry.name === 'saved')
  expect(saved.args.filter((arg) => arg.name === 'list-collections')).toEqual([{
    name: 'list-collections',
    type: 'bool',
    default: false,
    required: false,
    help: '只列出收藏夹，不读取笔记',
  }])
})

test('已有参数的旧定义会被替换，而不是保留旧文案', () => {
  const entries = upstream()
  entries[0].args.push({ name: 'list-collections', type: 'bool', default: false, required: false, help: '只列出收藏夹，不读取收藏笔记' })
  const manifest = applyTwice(entries)
  const saved = manifest.find((entry) => entry.name === 'saved')
  expect(saved.args.filter((arg) => arg.name === 'list-collections').map((arg) => arg.help)).toEqual(['只列出收藏夹，不读取笔记'])
})

test('search 增加排序、发布时间、笔记类型筛选和类型列', () => {
  const manifest = applyTwice(upstream())
  const search = manifest.find((entry) => entry.name === 'search')
  expect(search.args.map((arg) => arg.name)).toEqual(['query', 'sort', 'time', 'type'])
  expect(search.args.find((arg) => arg.name === 'sort').choices).toEqual(['general', 'latest', 'likes', 'comments', 'collects'])
  expect(search.args.find((arg) => arg.name === 'time').choices).toEqual(['all', 'day', 'week', 'half-year'])
  expect(search.args.find((arg) => arg.name === 'type').choices).toEqual(['all', 'video', 'image'])
  expect(search.columns).toEqual(['rank', 'title', 'author', 'likes', 'type', 'published_at', 'url'])
})

test('user-posts 只写入一次，并紧跟在 user 之后', () => {
  const manifest = applyTwice(upstream())
  const names = manifest.map((entry) => entry.name)
  expect(names.filter((name) => name === 'user-posts')).toHaveLength(1)
  expect(names.indexOf('user-posts')).toBe(names.indexOf('user') + 1)
  const entry = manifest.find((item) => item.name === 'user-posts')
  expect(entry).toMatchObject({ access: 'read', strategy: 'cookie', browser: true, modulePath: 'xiaohongshu/user-posts.js' })
  expect(entry.args.map((arg) => arg.name)).toEqual(['id', 'range', 'sort', 'timeout'])
})
