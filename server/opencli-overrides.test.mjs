// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
})
