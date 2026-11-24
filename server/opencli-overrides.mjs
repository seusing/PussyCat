// 把爪爪的原生命令(opencli-overrides/<站点>/)套进 OpenCLI 包:拷适配器文件,并改写 cli-manifest.json。
// 构建宿主 runtime 和运行时更新 OpenCLI 共用这一份逻辑,幂等。
import { copyFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// 相对 opencli-overrides/ 与包内 clis/ 的路径
const FILES = [
  'xiaohongshu/region.js',
  'xiaohongshu/auth.js',
  'xiaohongshu/collection-helpers.js',
  'xiaohongshu/saved.js',
  'xiaohongshu/collections.js',
  'xiaohongshu/search.js',
  'xiaohongshu/user-posts.js',
  'xiaohongshu/user-posts-helpers.js',
  'xiaohongshu/short-link.js',
  'xiaohongshu/note-helpers.js',
  'xiaohongshu/note.js',
  'xiaohongshu/comments.js',
  'xiaohongshu/download.js',
  '_shared/account-switch.js',
  'xiaohongshu/switch-account.js',
  'bilibili/switch-account.js',
  'twitter/switch-account.js',
  'youtube/switch-account.js',
  'xiaohongshu-dot/chat.js',
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

// 已有命令：追加输出列（已有则跳过）。whoami 换成了爪爪的 xiaohongshu/auth.js，多输出账号所在地区。
const COLUMN_PATCHES = {
  whoami: ['region'],
}

// 整条写入：新增命令插在 after 指向的命令之后（after 为 null 时追加到末尾，用于上游没有的站点）；
// 上游已有的同名条目（如 search）原位整条替换，不保留上游的参数。
// 切换账号:各站点同一套流程(_shared/account-switch.js),插在上游 login 后面
const switchAccountEntry = (site, domain, columns) => ({
  after: 'login',
  entry: {
    site,
    name: 'switch-account',
    description: `Open ${site} in the browser and wait until a different account is logged in`,
    access: 'write',
    domain,
    strategy: 'cookie',
    browser: true,
    // 与 _shared/account-switch.js 的 TIMEOUT_ARG 一致
    args: [{ name: 'timeout', type: 'int', default: 300, required: false, help: 'Seconds to wait for the new login (max 300)' }],
    columns: ['status', 'previous', 'logged_in', 'site', ...columns],
    type: 'js',
    modulePath: `${site}/switch-account.js`,
    sourceFile: `${site}/switch-account.js`,
    navigateBefore: false,
    siteSession: 'persistent',
    defaultWindowMode: 'foreground',
  },
})

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
  switchAccountEntry('xiaohongshu', 'creator.xiaohongshu.com', ['username', 'followers', 'region']),
  switchAccountEntry('bilibili', 'www.bilibili.com', ['id', 'username', 'level']),
  switchAccountEntry('twitter', 'x.com', ['username', 'url']),
  switchAccountEntry('youtube', 'www.youtube.com', ['name']),
  // 点点对话(xiaohongshu-dot/chat.js):chat 提问并流式回传,stop 调点点自己的停止生成
  {
    after: null,
    entry: {
      site: 'xiaohongshu-dot',
      name: 'chat',
      description: 'Ask Xiaohongshu 点点 in its web chat and stream the answer',
      access: 'write',
      domain: 'www.xiaohongshu.com',
      strategy: 'cookie',
      browser: true,
      args: [
        { name: 'query', type: 'str', required: true, positional: true, help: 'Question for 点点' },
        { name: 'conversation', type: 'string', required: false, help: 'Conversation id to continue; empty starts a new one' },
        { name: 'timeout', type: 'int', default: 180, required: false, help: 'Seconds to wait for the answer (max 180)' },
      ],
      columns: ['answer', 'source_total_text', 'source_count', 'conversation_id', 'message_id'],
      type: 'js',
      modulePath: 'xiaohongshu-dot/chat.js',
      sourceFile: 'xiaohongshu-dot/chat.js',
      navigateBefore: false,
      siteSession: 'persistent',
    },
  },
  {
    after: 'chat',
    entry: {
      site: 'xiaohongshu-dot',
      name: 'stop',
      description: 'Stop the answer 点点 is generating in the chat tab',
      access: 'read',
      domain: 'www.xiaohongshu.com',
      strategy: 'cookie',
      browser: true,
      args: [],
      columns: ['stopped'],
      type: 'js',
      modulePath: 'xiaohongshu-dot/chat.js',
      sourceFile: 'xiaohongshu-dot/chat.js',
      navigateBefore: false,
      siteSession: 'persistent',
    },
  },
]

/**
 * @param {object} options
 * @param {string} options.packageRoot OpenCLI 包根目录(含 cli-manifest.json 与 clis/)
 * @param {string} options.sourceDir 原生命令源文件目录(opencli-overrides)
 */
export function applyOpencliOverrides({ packageRoot, sourceDir }) {
  if (!existsSync(packageRoot)) {
    throw new Error(`[opencli-overrides] package not found: ${packageRoot}`)
  }

  for (const file of FILES) {
    const destination = join(packageRoot, 'clis', file)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(sourceDir, file), destination)
  }

  const manifestPath = join(packageRoot, 'cli-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const findEntry = (site, name) => manifest.find((entry) => entry.site === site && entry.name === name)

  for (const [name, args] of Object.entries(ARG_PATCHES)) {
    const entry = findEntry('xiaohongshu', name)
    if (!entry) throw new Error(`[opencli-overrides] xiaohongshu/${name} is missing from cli-manifest.json`)
    for (const arg of args) {
      const index = entry.args.findIndex((existing) => existing.name === arg.name)
      if (index >= 0) entry.args[index] = arg
      else entry.args.push(arg)
    }
  }

  for (const [name, columns] of Object.entries(COLUMN_PATCHES)) {
    const entry = findEntry('xiaohongshu', name)
    if (!entry) throw new Error(`[opencli-overrides] xiaohongshu/${name} is missing from cli-manifest.json`)
    const existing = entry.columns ?? []
    entry.columns = [...existing, ...columns.filter((column) => !existing.includes(column))]
  }

  for (const { after, entry } of NEW_ENTRIES) {
    const existing = findEntry(entry.site, entry.name)
    if (existing) {
      manifest[manifest.indexOf(existing)] = entry
      continue
    }
    if (after === null) {
      manifest.push(entry)
      continue
    }
    const anchor = findEntry(entry.site, after)
    if (!anchor) throw new Error(`[opencli-overrides] ${entry.site}/${after} is missing from cli-manifest.json`)
    manifest.splice(manifest.indexOf(anchor) + 1, 0, entry)
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
