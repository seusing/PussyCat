import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  emptyPreferences, toggleFavoriteSite, toggleFavoriteCommand, pushRecent,
  staleKeys, isSiteFavorited, isCommandFavorited, RECENT_CAP,
} from './preferences'
import type { CommandManifest } from './types'

// Vitest 从项目根启动 → process.cwd() = 仓库根
const snap = JSON.parse(readFileSync(resolve(process.cwd(), 'public/catalog.snapshot.json'), 'utf8'))
const commands: CommandManifest[] = snap.commands

test('真实 catalog 数量健全(>1000)', () => {
  expect(Array.isArray(commands)).toBe(true)
  expect(commands.length).toBeGreaterThan(1000)
})

test('真实 catalog fuzz:toggle/recent/stale 全程不抛、无键碰撞、stale 与 manifest 一致', () => {
  let prefs = emptyPreferences()
  // 确定性抽样(步长 7,避免 Math.random——脚本/复现友好)
  for (let i = 0; i < commands.length; i += 7) {
    const c = commands[i]
    prefs = toggleFavoriteCommand(prefs, c.command, c.site, i)   // 每命令仅 toggle 一次 → 全为新增
    prefs = pushRecent(prefs, c.command, i)
  }
  // 收藏命令键唯一
  const keys = prefs.favoriteCommands.map((f) => f.command)
  expect(new Set(keys).size).toBe(keys.length)
  // recent 不超上限
  expect(prefs.recent.length).toBeLessThanOrEqual(RECENT_CAP)
  // 所有收藏都真实存在 → stale 为空
  const stale = staleKeys(prefs, commands)
  expect(stale.commands.size).toBe(0)
  // isCommandFavorited 与内部数组一致
  for (const f of prefs.favoriteCommands) expect(isCommandFavorited(prefs, f.command)).toBe(true)
})

test('注入不存在收藏 → 必被标 stale', () => {
  let prefs = toggleFavoriteCommand(emptyPreferences(), 'ghost/none', 'ghost', 1)
  prefs = toggleFavoriteSite(prefs, 'ghost', 2)
  const stale = staleKeys(prefs, commands)
  expect(stale.commands.has('ghost/none')).toBe(true)
  expect(stale.sites.has('ghost')).toBe(true)
  expect(isSiteFavorited(prefs, 'ghost')).toBe(true)
})
