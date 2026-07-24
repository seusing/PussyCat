import { emptyPreferences, loadPreferences, savePreferences, PREFS_KEY } from './preferences'

// 内存假 Storage:纯函数可注入,不依赖 jsdom 全局
function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  }
}

test('emptyPreferences 结构正确', () => {
  expect(emptyPreferences()).toEqual({ schemaVersion: 1, favoriteSites: [], favoriteCommands: [], recent: [] })
})

test('save→load 往返等值', () => {
  const s = fakeStorage()
  const prefs = { schemaVersion: 1 as const, favoriteSites: [{ site: 'x', order: 0, createdAt: 1 }], favoriteCommands: [], recent: [{ command: 'x/go', at: 2 }] }
  savePreferences(prefs, s)
  expect(loadPreferences(s)).toEqual(prefs)
})

test('loadPreferences:空存储→empty', () => {
  expect(loadPreferences(fakeStorage())).toEqual(emptyPreferences())
})

test('loadPreferences:坏 JSON→empty 不抛', () => {
  const s = fakeStorage(); s.setItem(PREFS_KEY, '{not json')
  expect(loadPreferences(s)).toEqual(emptyPreferences())
})

test('loadPreferences:schemaVersion 不符→empty', () => {
  const s = fakeStorage(); s.setItem(PREFS_KEY, JSON.stringify({ schemaVersion: 2, favoriteSites: [], favoriteCommands: [], recent: [] }))
  expect(loadPreferences(s)).toEqual(emptyPreferences())
})

test('loadPreferences:缺字段→empty', () => {
  const s = fakeStorage(); s.setItem(PREFS_KEY, JSON.stringify({ schemaVersion: 1, favoriteSites: [] }))  // 缺 favoriteCommands/recent
  expect(loadPreferences(s)).toEqual(emptyPreferences())
})

import { isSiteFavorited, isCommandFavorited, toggleFavoriteSite, toggleFavoriteCommand, pushRecent, staleKeys, RECENT_CAP, restoreFavoriteSite } from './preferences'
import type { CommandManifest } from './types'

const mkCmd = (site: string, name: string): CommandManifest => ({
  command: `${site}/${name}`, site, name, description: '', access: 'read', browser: false, args: [],
})

test('toggleFavoriteSite 幂等往返 + order 递增 + 注入 now', () => {
  let p = emptyPreferences()
  p = toggleFavoriteSite(p, 'x', 100)
  expect(isSiteFavorited(p, 'x')).toBe(true)
  expect(p.favoriteSites[0]).toEqual({ site: 'x', order: 0, createdAt: 100 })
  p = toggleFavoriteSite(p, 'y', 200)
  expect(p.favoriteSites[1].order).toBe(1)          // order = max+1
  p = toggleFavoriteSite(p, 'x', 300)               // 再 toggle → 移除
  expect(isSiteFavorited(p, 'x')).toBe(false)
  expect(p.favoriteSites.map((f) => f.site)).toEqual(['y'])
})

test('toggleFavoriteCommand 存 command+site 两键', () => {
  let p = toggleFavoriteCommand(emptyPreferences(), 'x/go', 'x', 5)
  expect(isCommandFavorited(p, 'x/go')).toBe(true)
  expect(p.favoriteCommands[0]).toEqual({ command: 'x/go', site: 'x', order: 0, createdAt: 5 })
  p = toggleFavoriteCommand(p, 'x/go', 'x', 9)
  expect(isCommandFavorited(p, 'x/go')).toBe(false)
})

test('pushRecent 去重置顶 + 上限 RECENT_CAP', () => {
  let p = emptyPreferences()
  for (let i = 0; i < RECENT_CAP + 5; i++) p = pushRecent(p, `s/c${i}`, i)
  expect(p.recent).toHaveLength(RECENT_CAP)
  expect(p.recent[0].command).toBe(`s/c${RECENT_CAP + 4}`)   // 最近在前
  p = pushRecent(p, 's/c0', 999)                              // 重复命令 → 移除旧、置顶
  expect(p.recent.filter((r) => r.command === 's/c0')).toHaveLength(1)
  expect(p.recent[0]).toEqual({ command: 's/c0', at: 999 })
})

test('staleKeys 标记已失效收藏', () => {
  const commands = [mkCmd('x', 'go'), mkCmd('y', 'list')]
  let p = toggleFavoriteSite(emptyPreferences(), 'x', 1)
  p = toggleFavoriteSite(p, 'ghost', 2)
  p = toggleFavoriteCommand(p, 'y/list', 'y', 3)
  p = toggleFavoriteCommand(p, 'dead/none', 'dead', 4)
  const stale = staleKeys(p, commands)
  expect(stale.sites.has('ghost')).toBe(true)
  expect(stale.sites.has('x')).toBe(false)
  expect(stale.commands.has('dead/none')).toBe(true)
  expect(stale.commands.has('y/list')).toBe(false)
})

test('staleKeys 空 manifest → 空 stale(无法判定,不误灰)', () => {
  const p = toggleFavoriteSite(emptyPreferences(), 'x', 1)
  expect(staleKeys(p, []).sites.size).toBe(0)
})

test('restoreFavorite* 原记录原位回插且幂等', () => {
  let p = toggleFavoriteSite(emptyPreferences(), 'a', 100)
  p = toggleFavoriteSite(p, 'b', 200)
  const removed = p.favoriteSites[0]
  p = toggleFavoriteSite(p, 'a', 300)          // 取消 a
  p = restoreFavoriteSite(p, removed)
  const order = [...p.favoriteSites].sort((x, y) => x.createdAt - y.createdAt).map((f) => f.site)
  expect(order).toEqual(['a', 'b'])            // a 凭原 createdAt=100 回到 b 前
  expect(restoreFavoriteSite(p, removed)).toEqual(p)
})

test('元素结构校验:无效项丢弃、有效项保留、不再抛', () => {
  const s = fakeStorage()
  s.setItem(PREFS_KEY, JSON.stringify({
    schemaVersion: 1,
    favoriteSites: [null, { site: 'x', order: 0, createdAt: 1 }, {}, { site: 7, order: 0, createdAt: 1 }],
    favoriteCommands: [{ command: 'x/go', site: 'x', order: 0, createdAt: 1 }, { command: 'no-site' }, 42],
    recent: [{ command: 'x/go', at: 1 }, null, { command: 'x/go' }, { at: 2 }],
  }))
  const p = loadPreferences(s)
  expect(p.favoriteSites).toEqual([{ site: 'x', order: 0, createdAt: 1 }])
  expect(p.favoriteCommands).toEqual([{ command: 'x/go', site: 'x', order: 0, createdAt: 1 }])
  expect(p.recent).toEqual([{ command: 'x/go', at: 1 }])
  expect(isSiteFavorited(p, 'x')).toBe(true)   // 不抛且判定正确
})

test('localStorage 属性访问抛 SecurityError → load/save 降级不抛', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError: denied') } })
  try {
    expect(loadPreferences()).toEqual(emptyPreferences())
    expect(() => savePreferences(emptyPreferences())).not.toThrow()
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  }
})
