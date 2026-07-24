import { buildArgv, commandPreview } from './command'
import type { CommandManifest } from './types'

const cmd = (args: CommandManifest['args']): CommandManifest => ({
  command: 'xiaohongshu/download', site: 'xiaohongshu', name: 'download',
  description: '', access: 'read', browser: true, args,
})

test('buildArgv：站点+命令在前，flag 带值', () => {
  const c = cmd([{ name: 'timeout', type: 'int' }])
  expect(buildArgv(c, { timeout: 300 })).toEqual(['xiaohongshu', 'download', '--timeout', '300', '-f', 'json'])
})

test('buildArgv：布尔 true 发 --flag true，false 且无默认省略', () => {
  const c = cmd([{ name: 'images-only', type: 'boolean' }])
  expect(buildArgv(c, { 'images-only': true })).toEqual(['xiaohongshu', 'download', '--images-only', 'true', '-f', 'json'])
  expect(buildArgv(c, { 'images-only': false })).toEqual(['xiaohongshu', 'download', '-f', 'json'])
})
// 新增：default=true 关闭 → --flag false（核心 bug）
test('buildArgv：default=true 的布尔被关闭 → --flag false（非省略）', () => {
  const c = cmd([{ name: 'wait', type: 'boolean', default: true }])
  expect(buildArgv(c, { wait: false })).toEqual(['xiaohongshu', 'download', '--wait', 'false', '-f', 'json'])
  expect(buildArgv(c, { wait: true })).toEqual(['xiaohongshu', 'download', '-f', 'json']) // 与默认同 → 省略
  expect(buildArgv(c, {})).toEqual(['xiaohongshu', 'download', '-f', 'json']) // missing key is omitted
})

test('buildArgv: missing boolean key is omitted', () => {
  const c = cmd([{ name: 'verbose', type: 'boolean' }])
  expect(buildArgv(c, {})).toEqual(['xiaohongshu', 'download', '-f', 'json'])
})

test('buildArgv：positional 按顺序在 flag 之前，无 -- 前缀', () => {
  const c = cmd([
    { name: 'url', type: 'str', positional: true },
    { name: 'timeout', type: 'int' },
  ])
  expect(buildArgv(c, { url: 'https://x', timeout: 5 })).toEqual(['xiaohongshu', 'download', 'https://x', '--timeout', '5', '-f', 'json'])
})

test('buildArgv：空/未填值跳过', () => {
  const c = cmd([{ name: 'out', type: 'str' }])
  expect(buildArgv(c, {})).toEqual(['xiaohongshu', 'download', '-f', 'json'])
  expect(buildArgv(c, { out: '' })).toEqual(['xiaohongshu', 'download', '-f', 'json'])
})

test('commandPreview：opencli 前缀 + 含空格的值加引号', () => {
  const c = cmd([{ name: 'out', type: 'str' }])
  expect(commandPreview(c, { out: 'my dir' })).toBe('opencli xiaohongshu download --out "my dir" -f json')
  expect(commandPreview(c, { out: 'plain' })).toBe('opencli xiaohongshu download --out plain -f json')
})
// 新增：preview token 边界（值以 -- 开头不被误当 flag）
test('commandPreview：值以 -- 开头仍加引号，不误判为 flag', () => {
  const c = cmd([{ name: 'out', type: 'str' }])
  expect(commandPreview(c, { out: '--foo bar' })).toBe('opencli xiaohongshu download --out "--foo bar" -f json')
})
