// 把爪爪的原生命令(opencli-overrides/xiaohongshu/)套进 OpenCLI 包:拷适配器文件,并改写 cli-manifest.json。
// 构建宿主 runtime 和运行时更新 OpenCLI 共用这一份逻辑,幂等。
import { cpSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILES = [
  'collection-helpers.js',
  'saved.js',
  'collections.js',
  'search.js',
  'user-posts.js',
  'user-posts-helpers.js',
  'short-link.js',
  'note-helpers.js',
  'note.js',
  'comments.js',
  'download.js',
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
}

// 整条写入：新增命令插在 after 指向的命令之后；上游已有的同名条目（如 search）原位整条替换，不保留上游的参数。
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
    after: 'collections',
    entry: {
      site: 'xiaohongshu',
      name: 'search',
      description: '搜索小红书笔记',
      ...browserCommand,
      args: [
        { name: 'query', type: 'str', required: true, positional: true, help: 'Search keyword' },
        { name: 'limit', type: 'int', default: 20, required: false, help: 'Number of results' },
        { name: 'sort', type: 'string', default: 'general', required: false, choices: ['general', 'latest', 'likes', 'comments', 'collects'], help: 'Sort order: general, latest, likes, comments, collects' },
        { name: 'time', type: 'string', default: 'all', required: false, choices: ['all', 'day', 'week', 'half-year'], help: 'Publish time: all, day, week, half-year' },
        { name: 'type', type: 'string', default: 'all', required: false, choices: ['all', 'video', 'image'], help: 'Note type: all, video, image' },
      ],
      columns: ['rank', 'title', 'author', 'likes', 'type', 'published_at', 'url'],
      modulePath: 'xiaohongshu/search.js',
      sourceFile: 'xiaohongshu/search.js',
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
        { name: 'keyword', type: 'string', required: false, help: 'Only keep notes whose title contains all of these words (space-separated); titles only' },
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

/**
 * @param {object} options
 * @param {string} options.packageRoot OpenCLI 包根目录(含 cli-manifest.json 与 clis/)
 * @param {string} options.sourceDir 原生命令源文件目录(opencli-overrides/xiaohongshu)
 */
export function applyOpencliOverrides({ packageRoot, sourceDir }) {
  if (!existsSync(packageRoot)) {
    throw new Error(`[opencli-overrides] package not found: ${packageRoot}`)
  }

  const destination = join(packageRoot, 'clis/xiaohongshu')
  mkdirSync(destination, { recursive: true })
  for (const name of FILES) {
    cpSync(join(sourceDir, name), join(destination, name))
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
}
