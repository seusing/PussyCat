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
  // v2 新增 acknowledgements 字段(Task 8);改写而非删除既有断言(R7)
  expect(emptyPreferences()).toEqual({ schemaVersion: 1, favoriteSites: [], favoriteCommands: [], recent: [], acknowledgements: [] })
})

test('save→load 往返等值', () => {
  const s = fakeStorage()
  const prefs = { schemaVersion: 1 as const, favoriteSites: [{ site: 'x', order: 0, createdAt: 1 }], favoriteCommands: [], recent: [{ command: 'x/go', at: 2 }], acknowledgements: [] }
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

test('loadPreferences: 收藏数组按唯一键去重(首见保留;二轮复审 P2)', () => {
  const s = fakeStorage()
  s.setItem(PREFS_KEY, JSON.stringify({
    schemaVersion: 1,
    favoriteSites: [{ site: 'x', order: 0, createdAt: 1 }, { site: 'x', order: 5, createdAt: 9 }, { site: 'y', order: 1, createdAt: 2 }],
    favoriteCommands: [{ command: 'x/go', site: 'x', order: 0, createdAt: 1 }, { command: 'x/go', site: 'x', order: 3, createdAt: 7 }],
    recent: [],
  }))
  const p = loadPreferences(s)
  expect(p.favoriteSites).toEqual([{ site: 'x', order: 0, createdAt: 1 }, { site: 'y', order: 1, createdAt: 2 }])
  expect(p.favoriteCommands).toEqual([{ command: 'x/go', site: 'x', order: 0, createdAt: 1 }])
})

test('loadPreferences: recent 去重+RECENT_CAP 截断(载入端与 pushRecent 不变量对齐)', () => {
  const s = fakeStorage()
  const many = Array.from({ length: RECENT_CAP + 5 }, (_, i) => ({ command: `s/c${i}`, at: i }))
  s.setItem(PREFS_KEY, JSON.stringify({ schemaVersion: 1, favoriteSites: [], favoriteCommands: [], recent: [{ command: 's/c0', at: 99 }, ...many] }))
  const p = loadPreferences(s)
  expect(p.recent).toHaveLength(RECENT_CAP)
  expect(p.recent.filter((r) => r.command === 's/c0')).toHaveLength(1)
  expect(p.recent[0]).toEqual({ command: 's/c0', at: 99 })   // 首见(最近)保留,重复丢弃
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

// —— Task 8: preferences v2 迁移 + acknowledgement 管理 ——
import { acknowledge, revokeAcknowledgement, isAcknowledged, PREFS_KEY_V2 } from './preferences'
import type { Acknowledgement } from './preferences'

function memoryStorage(): Storage { return fakeStorage() }

describe('preferences v2', () => {
  it('v1 数据自动迁移,收藏与 recent 全部保留', () => {
    const s = memoryStorage()
    s.setItem('opencli-app:prefs:v1', JSON.stringify({
      favoriteSites: [{ site: 'a', createdAt: 1 }],
      favoriteCommands: [{ command: 'a/b', site: 'a', createdAt: 2 }],
      recent: [{ command: 'a/b', at: 3 }],
    }))
    const prefs = loadPreferences(s)
    expect(prefs.favoriteSites).toHaveLength(1)
    expect(prefs.favoriteCommands).toHaveLength(1)
    expect(prefs.recent).toHaveLength(1)
    expect(prefs.acknowledgements).toEqual([])
    expect(s.getItem('opencli-app:prefs:v2')).toBeTruthy()
  })

  it('坏项逐项丢弃,好项保留', () => {
    const s = memoryStorage()
    s.setItem('opencli-app:prefs:v2', JSON.stringify({
      favoriteSites: [{ site: 'a', createdAt: 1 }, null, { site: 5 }],
      favoriteCommands: [], recent: [],
      acknowledgements: [{ commandKey: 'a/b', fingerprint: 'f', acknowledgedAt: 1 }, { commandKey: 7 }],
    }))
    const prefs = loadPreferences(s)
    expect(prefs.favoriteSites).toHaveLength(1)
    expect(prefs.acknowledgements).toHaveLength(1)
  })

  it('确认绑 fingerprint —— 指纹变了即失效', () => {
    let prefs = emptyPreferences()
    prefs = acknowledge(prefs, 'a/b', 'fp1', 100)
    expect(isAcknowledged(prefs, 'a/b', 'fp1')).toBe(true)
    expect(isAcknowledged(prefs, 'a/b', 'fp2')).toBe(false)
  })

  it('可撤销', () => {
    let prefs = acknowledge(emptyPreferences(), 'a/b', 'fp1', 100)
    prefs = revokeAcknowledgement(prefs, 'a/b')
    expect(isAcknowledged(prefs, 'a/b', 'fp1')).toBe(false)
  })

  it('同一 commandKey 只保留最新一条(指纹更新覆盖,不堆积)', () => {
    let prefs = acknowledge(emptyPreferences(), 'a/b', 'fp1', 100)
    prefs = acknowledge(prefs, 'a/b', 'fp2', 200)
    expect(prefs.acknowledgements).toHaveLength(1)
    expect(prefs.acknowledgements[0]).toEqual({ commandKey: 'a/b', fingerprint: 'fp2', acknowledgedAt: 200 })
  })

  it('storage 不可写时不抛,且返回「本次有效」标记', () => {
    const failing = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
    const prefs = acknowledge(emptyPreferences(), 'a/b', 'fp', 1)
    expect(() => savePreferences(prefs, failing as unknown as Storage)).not.toThrow()
    expect(savePreferences(prefs, failing as unknown as Storage)).toBe(false)   // false = 未持久化
  })
})

test('I-P7 守卫:acknowledgement 落盘 JSON 永不含 values/argv/result/error/detail', () => {
  const s = memoryStorage()
  // 模拟一份被污染的 v2 存储:acknowledgement 条目夹带运行期字段
  const dirty = {
    commandKey: 'a/b', fingerprint: 'f', acknowledgedAt: 1,
    values: { secret: 1 }, argv: ['a', 'b'], result: [{ ok: true }], error: 'boom', detail: 'stack trace',
  }
  s.setItem(PREFS_KEY_V2, JSON.stringify({
    schemaVersion: 1, favoriteSites: [], favoriteCommands: [], recent: [], acknowledgements: [dirty],
  }))

  // 读入内存后必须已被裁剪成三字段
  const loaded = loadPreferences(s)
  expect(Object.keys(loaded.acknowledgements[0])).toEqual(['commandKey', 'fingerprint', 'acknowledgedAt'])

  // 喂给 acknowledge() 追加一条新确认,再落盘——全量持久化 JSON 里,五个禁止字段一个都不许出现
  const next = acknowledge(loaded, 'c/d', 'fp2', 2)
  savePreferences(next, s)
  const persisted = JSON.parse(s.getItem(PREFS_KEY_V2)!) as { acknowledgements: Acknowledgement[] }
  for (const ack of persisted.acknowledgements) {
    expect(Object.keys(ack)).toEqual(expect.not.arrayContaining(['values', 'argv', 'result', 'error', 'detail']))
  }
  expect(persisted.acknowledgements).toHaveLength(2)
})
