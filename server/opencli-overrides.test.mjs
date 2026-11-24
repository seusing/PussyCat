// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyOpencliOverrides } from './opencli-overrides.mjs'
import { TIMEOUT_ARG } from '../opencli-overrides/_shared/account-switch.js'

const sourceDir = resolve('opencli-overrides')
const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function packageWith(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'opencli-overrides-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'cli-manifest.json'), JSON.stringify(entries))
  return dir
}

const upstream = () => [
  { site: 'xiaohongshu', name: 'whoami', args: [], columns: ['logged_in', 'site', 'username', 'followers'] },
  { site: 'xiaohongshu', name: 'saved', args: [] },
  { site: 'xiaohongshu', name: 'user', args: [] },
  { site: 'xiaohongshu', name: 'login', args: [] },
  { site: 'bilibili', name: 'hot', args: [] },
  { site: 'bilibili', name: 'login', args: [] },
  { site: 'twitter', name: 'login', args: [] },
  { site: 'youtube', name: 'login', args: [] },
]

describe('applyOpencliOverrides', () => {
  it('拷贝原生命令文件并改写 manifest,别的站点不动', () => {
    const packageRoot = packageWith(upstream())
    applyOpencliOverrides({ packageRoot, sourceDir })
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'cli-manifest.json'), 'utf8'))
    expect(manifest.filter((entry) => entry.site === 'xiaohongshu').map((entry) => entry.name))
      .toEqual(['whoami', 'saved', 'collections', 'search', 'user', 'user-posts', 'login', 'switch-account'])
    // whoami 换成爪爪的 auth.js(大陆版、国际版都查),多一列 region
    expect(manifest.find((entry) => entry.name === 'whoami').columns).toEqual(['logged_in', 'site', 'username', 'followers', 'region'])
    expect(manifest.find((entry) => entry.site === 'bilibili')).toEqual({ site: 'bilibili', name: 'hot', args: [] })
    expect(readFileSync(join(packageRoot, 'clis', 'xiaohongshu', 'search.js'), 'utf8')).toBe(readFileSync(join(sourceDir, 'xiaohongshu', 'search.js'), 'utf8'))
  })

  it('四个站点各加一条切换账号,插在上游 login 后面,共用 _shared 流程', () => {
    const packageRoot = packageWith(upstream())
    applyOpencliOverrides({ packageRoot, sourceDir })
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'cli-manifest.json'), 'utf8'))
    for (const site of ['xiaohongshu', 'bilibili', 'twitter', 'youtube']) {
      const login = manifest.findIndex((entry) => entry.site === site && entry.name === 'login')
      expect(manifest[login + 1], site).toMatchObject({
        site, name: 'switch-account', access: 'write', browser: true,
        modulePath: `${site}/switch-account.js`, siteSession: 'persistent', defaultWindowMode: 'foreground',
      })
      // manifest 的参数要与适配器里声明的一致,opencli 才按它给命令计时
      expect(manifest[login + 1].args, site).toEqual([{ ...TIMEOUT_ARG, required: false }])
      expect(readFileSync(join(packageRoot, 'clis', site, 'switch-account.js'), 'utf8')).toContain('_shared/account-switch.js')
    }
    expect(readFileSync(join(packageRoot, 'clis', '_shared', 'account-switch.js'), 'utf8'))
      .toBe(readFileSync(join(sourceDir, '_shared', 'account-switch.js'), 'utf8'))
  })

  it('上游没有的站点 xiaohongshu-dot:chat、stop 追加到末尾,套第二次原位替换不重复', () => {
    const packageRoot = packageWith(upstream())
    applyOpencliOverrides({ packageRoot, sourceDir })
    applyOpencliOverrides({ packageRoot, sourceDir })
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'cli-manifest.json'), 'utf8'))
    const dot = manifest.filter((entry) => entry.site === 'xiaohongshu-dot')
    expect(dot.map((entry) => entry.name)).toEqual(['chat', 'stop'])
    expect(manifest.slice(-2)).toEqual(dot)
    expect(dot[0]).toMatchObject({ access: 'write', siteSession: 'persistent', modulePath: 'xiaohongshu-dot/chat.js' })
    // stop 记成 read,才不会被正在运行的 chat 的写租约挡住
    expect(dot[1]).toMatchObject({ access: 'read', siteSession: 'persistent', modulePath: 'xiaohongshu-dot/chat.js' })
    expect(readFileSync(join(packageRoot, 'clis', 'xiaohongshu-dot', 'chat.js'), 'utf8'))
      .toBe(readFileSync(join(sourceDir, 'xiaohongshu-dot', 'chat.js'), 'utf8'))
  })

  it('幂等:套两次结果一样', () => {
    const packageRoot = packageWith(upstream())
    applyOpencliOverrides({ packageRoot, sourceDir })
    const once = readFileSync(join(packageRoot, 'cli-manifest.json'), 'utf8')
    applyOpencliOverrides({ packageRoot, sourceDir })
    expect(readFileSync(join(packageRoot, 'cli-manifest.json'), 'utf8')).toBe(once)
  })

  it('包目录不存在或缺锚点命令时报错', () => {
    expect(() => applyOpencliOverrides({ packageRoot: join(tmpdir(), 'opencli-no-such-package'), sourceDir })).toThrow('package not found')
    const packageRoot = packageWith([{ site: 'bilibili', name: 'hot', args: [] }])
    mkdirSync(join(packageRoot, 'clis'), { recursive: true })
    expect(() => applyOpencliOverrides({ packageRoot, sourceDir })).toThrow('xiaohongshu/saved is missing')
  })

  // 装机版数据根是 LOCALAPPDATA 下的「爪爪-data」(带中文);目标文件已存在(第二次更新、或包里本来就有同名文件)时,
  // Node 25 的 fs.cpSync 在这种路径下会抛出 "The operation completed successfully" 的怪错,逐个文件拷贝要用 copyFileSync。
  it('包目录路径带中文、目标文件已存在时照样覆盖成功', () => {
    const packageRoot = mkdtempSync(join(tmpdir(), '爪爪-overrides-'))
    dirs.push(packageRoot)
    writeFileSync(join(packageRoot, 'cli-manifest.json'), JSON.stringify(upstream()))
    const files = readdirSync(sourceDir, { recursive: true })
      .map((name) => String(name).replaceAll('\\', '/'))
      .filter((name) => name.endsWith('.js') && !name.includes('.test.'))
    for (const name of files) {
      mkdirSync(dirname(join(packageRoot, 'clis', name)), { recursive: true })
      writeFileSync(join(packageRoot, 'clis', name), 'old content')
    }

    expect(() => applyOpencliOverrides({ packageRoot, sourceDir })).not.toThrow()

    expect(files).toHaveLength(19)
    for (const name of files) {
      expect(readFileSync(join(packageRoot, 'clis', name), 'utf8'), name).toBe(readFileSync(join(sourceDir, name), 'utf8'))
    }
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'cli-manifest.json'), 'utf8'))
    expect(manifest.map((entry) => entry.name)).toEqual(expect.arrayContaining(['collections', 'search', 'user-posts']))
  })
})
