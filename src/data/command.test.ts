import { buildArgv, commandPreview } from './command'
import type { CommandManifest } from './types'

const cmd = (args: CommandManifest['args']): CommandManifest => ({
  command: 'xiaohongshu/download', site: 'xiaohongshu', name: 'download',
  description: '', access: 'read', browser: true, args,
})

test('buildArgv：站点+命令在前，flag 带值', () => {
  const c = cmd([{ name: 'timeout', type: 'int' }])
  expect(buildArgv(c, { timeout: 300 })).toEqual(['xiaohongshu', 'download', '--timeout', '300'])
})

test('buildArgv：布尔 true 只加 flag，false 省略', () => {
  const c = cmd([{ name: 'images-only', type: 'boolean' }])
  expect(buildArgv(c, { 'images-only': true })).toEqual(['xiaohongshu', 'download', '--images-only'])
  expect(buildArgv(c, { 'images-only': false })).toEqual(['xiaohongshu', 'download'])
})

test('buildArgv：positional 按顺序在 flag 之前，无 -- 前缀', () => {
  const c = cmd([
    { name: 'url', type: 'str', positional: true },
    { name: 'timeout', type: 'int' },
  ])
  expect(buildArgv(c, { url: 'https://x', timeout: 5 })).toEqual(['xiaohongshu', 'download', 'https://x', '--timeout', '5'])
})

test('buildArgv：空/未填值跳过', () => {
  const c = cmd([{ name: 'out', type: 'str' }])
  expect(buildArgv(c, {})).toEqual(['xiaohongshu', 'download'])
  expect(buildArgv(c, { out: '' })).toEqual(['xiaohongshu', 'download'])
})

test('commandPreview：opencli 前缀 + 含空格的值加引号', () => {
  const c = cmd([{ name: 'out', type: 'str' }])
  expect(commandPreview(c, { out: 'my dir' })).toBe('opencli xiaohongshu download --out "my dir"')
  expect(commandPreview(c, { out: 'plain' })).toBe('opencli xiaohongshu download --out plain')
})
