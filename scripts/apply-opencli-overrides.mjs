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

const destination = join(packageRoot, 'clis/xiaohongshu')
mkdirSync(destination, { recursive: true })
for (const name of ['collection-helpers.js', 'saved.js', 'collections.js']) {
  cpSync(join(source, name), join(destination, name))
}

const manifestPath = join(packageRoot, 'cli-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const saved = manifest.find((entry) => entry.site === 'xiaohongshu' && entry.name === 'saved')
if (!saved) throw new Error('[opencli-overrides] xiaohongshu/saved is missing from cli-manifest.json')
if (!saved.args.some((arg) => arg.name === 'collection')) {
  saved.args.push({
    name: 'collection',
    type: 'string',
    required: false,
    help: '按专辑名称筛选；留空读取全部收藏',
  })
}

if (!manifest.some((entry) => entry.site === 'xiaohongshu' && entry.name === 'collections')) {
  const savedIndex = manifest.indexOf(saved)
  manifest.splice(savedIndex + 1, 0, {
    site: 'xiaohongshu',
    name: 'collections',
    description: '小红书收藏专辑列表',
    access: 'read',
    domain: 'www.xiaohongshu.com',
    strategy: 'cookie',
    browser: true,
    args: [
      { name: 'id', type: 'string', required: false, help: 'User id or profile URL (defaults to current logged-in user)' },
      { name: 'limit', type: 'int', default: 100, required: false, help: 'Number of collections to return' },
    ],
    columns: ['rank', 'id', 'name', 'count', 'url'],
    type: 'js',
    modulePath: 'xiaohongshu/collections.js',
    sourceFile: 'xiaohongshu/collections.js',
    navigateBefore: false,
  })
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`[opencli-overrides] applied to ${packageRoot}`)
