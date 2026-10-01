import { cpSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targetArg = process.argv.find((arg) => arg.startsWith('--target='))
const target = resolve(root, targetArg ? targetArg.slice('--target='.length) : 'node_modules/@jackwener/opencli')
const source = join(root, 'opencli-overrides/xiaohongshu')
const packageRoot = target

if (!existsSync(packageRoot)) {
  throw new Error(`[opencli-overrides] package not found: ${packageRoot}`)
}

const FILES = [
  'collection-helpers.js',
  'saved.js',
  'collections.js',
  'search.js',
  'user-posts.js',
  'user-posts-helpers.js',
]

const browserCommand = {
  access: 'read',
  domain: 'www.xiaohongshu.com',
  strategy: 'cookie',
  browser: true,
  type: 'js',
  navigateBefore: false,
}

// 已有命令：按参数名覆盖（有则替换、无则追加），定义改了也会写进已打过补丁的包。
const ARG_PATCHES = {
  saved: [
    { name: 'collection', type: 'string', required: false, help: '按收藏夹名称筛选；留空读取全部收藏' },
    { name: 'list-collections', type: 'bool', default: false, required: false, help: '只列出收藏夹，不读取笔记' },
  ],
  search: [
    { name: 'sort', type: 'string', default: 'general', required: false, choices: ['general', 'latest', 'likes', 'comments', 'collects'], help: 'Sort order: general, latest, likes, comments, collects' },
    { name: 'time', type: 'string', default: 'all', required: false, choices: ['all', 'day', 'week', 'half-year'], help: 'Publish time: all, day, week, half-year' },
    { name: 'type', type: 'string', default: 'all', required: false, choices: ['all', 'video', 'image'], help: 'Note type: all, video, image' },
  ],
}

const COLUMN_PATCHES = {
  search: ['rank', 'title', 'author', 'likes', 'type', 'published_at', 'url'],
}

// 新增命令：整条写入，插在 after 指向的命令之后。
const NEW_ENTRIES = [
  {
    after: 'saved',
    entry: {
      site: 'xiaohongshu',
      name: 'collections',
      description: '小红书收藏专辑列表',
      ...browserCommand,
      args: [
        { name: 'id', type: 'string', required: false, help: 'User id or profile URL (defaults to current logged-in user)' },
        { name: 'limit', type: 'int', default: 100, required: false, help: 'Number of collections to return' },
      ],
      columns: ['rank', 'id', 'name', 'count', 'url'],
      modulePath: 'xiaohongshu/collections.js',
      sourceFile: 'xiaohongshu/collections.js',
    },
  },
  {
    after: 'user',
    entry: {
      site: 'xiaohongshu',
      name: 'user-posts',
      description: 'List all notes of a Xiaohongshu user, filtered by publish time and sorted by time or likes',
      ...browserCommand,
      args: [
        { name: 'id', type: 'string', required: true, positional: true, help: 'User id or profile URL' },
        { name: 'range', type: 'string', default: 'all', required: false, choices: ['all', 'today', '3d', '7d', '15d', '1m', '3m', '6m'], help: 'Publish time range' },
        { name: 'sort', type: 'string', default: 'time', required: false, choices: ['time', 'likes'], help: 'Sort by publish time or likes' },
        { name: 'timeout', type: 'int', default: 600, required: false, help: 'Max seconds to spend scrolling the profile' },
      ],
      columns: ['rank', 'title', 'type', 'likes', 'published_at', 'url'],
      modulePath: 'xiaohongshu/user-posts.js',
      sourceFile: 'xiaohongshu/user-posts.js',
    },
  },
]

const destination = join(packageRoot, 'clis/xiaohongshu')
mkdirSync(destination, { recursive: true })
for (const name of FILES) {
  cpSync(join(source, name), join(destination, name))
}

const manifestPath = join(packageRoot, 'cli-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const findEntry = (name) => manifest.find((entry) => entry.site === 'xiaohongshu' && entry.name === name)

for (const [name, args] of Object.entries(ARG_PATCHES)) {
  const entry = findEntry(name)
  if (!entry) throw new Error(`[opencli-overrides] xiaohongshu/${name} is missing from cli-manifest.json`)
  for (const arg of args) {
    const index = entry.args.findIndex((existing) => existing.name === arg.name)
    if (index >= 0) entry.args[index] = arg
    else entry.args.push(arg)
  }
}

for (const [name, columns] of Object.entries(COLUMN_PATCHES)) {
  const entry = findEntry(name)
  if (!entry) throw new Error(`[opencli-overrides] xiaohongshu/${name} is missing from cli-manifest.json`)
  entry.columns = columns
}

for (const { after, entry } of NEW_ENTRIES) {
  const existing = findEntry(entry.name)
  if (existing) {
    manifest[manifest.indexOf(existing)] = entry
    continue
  }
  const anchor = findEntry(after)
  if (!anchor) throw new Error(`[opencli-overrides] xiaohongshu/${after} is missing from cli-manifest.json`)
  manifest.splice(manifest.indexOf(anchor) + 1, 0, entry)
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`[opencli-overrides] applied to ${packageRoot}`)
