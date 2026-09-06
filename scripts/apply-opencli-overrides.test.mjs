import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'

const fixtures = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

test('saved 幂等追加收藏夹列表开关', () => {
  const target = mkdtempSync(join(tmpdir(), 'opencli-override-'))
  fixtures.push(target)
  mkdirSync(join(target, 'clis', 'xiaohongshu'), { recursive: true })
  writeFileSync(join(target, 'cli-manifest.json'), JSON.stringify([{
    site: 'xiaohongshu',
    name: 'saved',
    args: [],
  }]))

  const script = join(process.cwd(), 'scripts', 'apply-opencli-overrides.mjs')
  execFileSync(process.execPath, [script, `--target=${target}`])
  execFileSync(process.execPath, [script, `--target=${target}`])

  const manifest = JSON.parse(readFileSync(join(target, 'cli-manifest.json'), 'utf8'))
  const saved = manifest.find((entry) => entry.site === 'xiaohongshu' && entry.name === 'saved')
  expect(saved.args.filter((arg) => arg.name === 'list-collections')).toEqual([{
    name: 'list-collections',
    type: 'bool',
    default: false,
    required: false,
    help: '只列出收藏夹，不读取笔记',
  }])
})
