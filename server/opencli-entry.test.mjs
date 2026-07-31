// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveOpenCliEntry } from './opencli-entry.mjs'

describe('resolveOpenCliEntry', () => {
  it('resolves the pinned package directly to dist/src/main.js', () => {
    expect(resolveOpenCliEntry()).toMatch(/[\\/]@jackwener[\\/]opencli[\\/]dist[\\/]src[\\/]main\.js$/i)
  })
})

import { sep } from 'node:path'
import { resolveManifestPath } from './opencli-entry.mjs'

// 夹具用**平台原生分隔符**拼,不写死反斜杠字面量。
// 被测函数用的是 node:path 的平台实现:在 POSIX 上反斜杠**不是分隔符**,
// 'C:\\x\\...\\main.js' 整串会被当成单个文件名,dirname 返回 '.',于是包根解析到 CI 工作目录
// (实测 Linux runner 上得到 /home/runner/work/cli-manifest.json)。
// 这条测试此前只在 Windows 上跑过,接了 CI 才暴露 —— 记在这里,免得后人又写死一次。
const fixtureEntry = (...segments) => segments.join(sep)

it('resolveManifestPath: 从 entry 反推包根 cli-manifest.json', () => {
  const entry = fixtureEntry('C:', 'x', 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js')
  const seen = []
  const path = resolveManifestPath(entry, { existsImpl: (p) => { seen.push(p); return true } })
  expect(path.split(sep).join('/')).toMatch(/@jackwener\/opencli\/cli-manifest\.json$/)
  expect(seen).toHaveLength(1)
})

it('resolveManifestPath: manifest 不存在 → throw', () => {
  expect(() => resolveManifestPath(fixtureEntry('C:', 'x', 'dist', 'src', 'main.js'), { existsImpl: () => false }))
    .toThrow(/cli-manifest/)
})
