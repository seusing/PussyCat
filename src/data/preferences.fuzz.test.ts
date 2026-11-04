import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { emptyPreferences, pushRecent, staleKeys, RECENT_CAP } from './preferences'
import type { FavoriteCommand } from './preferences'
import type { CommandManifest } from './types'

// Vitest 从项目根启动 → process.cwd() = 仓库根
const snap = JSON.parse(readFileSync(resolve(process.cwd(), 'public/catalog.snapshot.json'), 'utf8'))
const commands: CommandManifest[] = snap.commands

test('真实 catalog 数量健全(>1000)', () => {
  expect(Array.isArray(commands)).toBe(true)
  expect(commands.length).toBeGreaterThan(1000)
})

test('真实 catalog fuzz:收藏/recent/stale 全程不抛、无键碰撞、stale 与 manifest 一致', () => {
  let prefs = emptyPreferences()
  const favoriteCommands: FavoriteCommand[] = []
  // 确定性抽样(步长 7,避免 Math.random——脚本/复现友好)
  for (let i = 0; i < commands.length; i += 7) {
    const c = commands[i]
    favoriteCommands.push({ command: c.command, site: c.site, order: favoriteCommands.length, createdAt: i })
    prefs = pushRecent(prefs, c.command, i)
  }
  prefs = { ...prefs, favoriteCommands }
  // 收藏命令键唯一
  const keys = prefs.favoriteCommands.map((f) => f.command)
  expect(new Set(keys).size).toBe(keys.length)
  // recent 不超上限
  expect(prefs.recent.length).toBeLessThanOrEqual(RECENT_CAP)
  // 所有收藏都真实存在 → stale 为空
  const stale = staleKeys(prefs, commands)
  expect(stale.commands.size).toBe(0)
})

test('注入不存在收藏 → 必被标 stale', () => {
  const prefs = {
    ...emptyPreferences(),
    favoriteSites: [{ site: 'ghost', order: 0, createdAt: 2 }],
    favoriteCommands: [{ command: 'ghost/none', site: 'ghost', order: 0, createdAt: 1 }],
  }
  const stale = staleKeys(prefs, commands)
  expect(stale.commands.has('ghost/none')).toBe(true)
  expect(stale.sites.has('ghost')).toBe(true)
})
