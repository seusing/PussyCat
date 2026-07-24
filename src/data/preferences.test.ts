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
