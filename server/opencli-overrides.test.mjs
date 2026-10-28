// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyOpencliOverrides } from './opencli-overrides.mjs'

const sourceDir = resolve('opencli-overrides/xiaohongshu')
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
  { site: 'xiaohongshu', name: 'saved', args: [] },
  { site: 'xiaohongshu', name: 'user', args: [] },
  { site: 'bilibili', name: 'hot', args: [] },
]

describe('applyOpencliOverrides', () => {
  it('拷贝原生命令文件并改写 manifest,别的站点不动', () => {
    const packageRoot = packageWith(upstream())
    applyOpencliOverrides({ packageRoot, sourceDir })
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'cli-manifest.json'), 'utf8'))
    expect(manifest.filter((entry) => entry.site === 'xiaohongshu').map((entry) => entry.name))
      .toEqual(['saved', 'collections', 'search', 'user', 'user-posts'])
    expect(manifest.find((entry) => entry.site === 'bilibili')).toEqual({ site: 'bilibili', name: 'hot', args: [] })
    expect(readFileSync(join(packageRoot, 'clis', 'xiaohongshu', 'search.js'), 'utf8')).toBe(readFileSync(join(sourceDir, 'search.js'), 'utf8'))
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
    const files = readdirSync(sourceDir).filter((name) => name.endsWith('.js') && !name.includes('.test.'))
    mkdirSync(join(packageRoot, 'clis', 'xiaohongshu'), { recursive: true })
    for (const name of files) writeFileSync(join(packageRoot, 'clis', 'xiaohongshu', name), 'old content')

    expect(() => applyOpencliOverrides({ packageRoot, sourceDir })).not.toThrow()

    expect(files).toHaveLength(11)
    for (const name of files) {
      expect(readFileSync(join(packageRoot, 'clis', 'xiaohongshu', name), 'utf8'), name).toBe(readFileSync(join(sourceDir, name), 'utf8'))
    }
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'cli-manifest.json'), 'utf8'))
    expect(manifest.map((entry) => entry.name)).toEqual(expect.arrayContaining(['collections', 'search', 'user-posts']))
  })
})
