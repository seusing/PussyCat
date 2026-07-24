import type { CommandManifest } from './types'

export const PREFS_KEY = 'opencli-app:prefs:v1'
export const RECENT_CAP = 20

export type FavoriteSite = { site: string; order: number; createdAt: number }
export type FavoriteCommand = { command: string; site: string; order: number; createdAt: number }
export type RecentEntry = { command: string; at: number }

export type PreferencesSnapshot = {
  schemaVersion: 1
  favoriteSites: FavoriteSite[]
  favoriteCommands: FavoriteCommand[]
  recent: RecentEntry[]
}

export function emptyPreferences(): PreferencesSnapshot {
  return { schemaVersion: 1, favoriteSites: [], favoriteCommands: [], recent: [] }
}

function resolveStorage(storage?: Storage): Storage | undefined {
  if (storage) return storage
  try {
    // 浏览器封锁存储时,访问 localStorage 属性本身会抛 SecurityError
    return typeof localStorage !== 'undefined' ? localStorage : undefined
  } catch {
    return undefined
  }
}

const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
function isFavSite(x: unknown): x is FavoriteSite {
  const o = x as FavoriteSite
  return !!o && typeof o === 'object' && typeof o.site === 'string' && isFiniteNum(o.order) && isFiniteNum(o.createdAt)
}
function isFavCommand(x: unknown): x is FavoriteCommand {
  const o = x as FavoriteCommand
  return !!o && typeof o === 'object' && typeof o.command === 'string' && typeof o.site === 'string' && isFiniteNum(o.order) && isFiniteNum(o.createdAt)
}
function isRecentEntry(x: unknown): x is RecentEntry {
  const o = x as RecentEntry
  return !!o && typeof o === 'object' && typeof o.command === 'string' && isFiniteNum(o.at)
}

function uniqueBy<T>(items: T[], keyOf: (x: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const it of items) {
    const k = keyOf(it)
    if (!seen.has(k)) { seen.add(k); out.push(it) }
  }
  return out
}

export function loadPreferences(storage?: Storage): PreferencesSnapshot {
  const s = resolveStorage(storage)
  if (!s) return emptyPreferences()
  try {
    const raw = s.getItem(PREFS_KEY)
    if (!raw) return emptyPreferences()
    const p = JSON.parse(raw)
    if (p?.schemaVersion !== 1) return emptyPreferences()
    if (!Array.isArray(p.favoriteSites) || !Array.isArray(p.favoriteCommands) || !Array.isArray(p.recent)) {
      return emptyPreferences()
    }
    // 载入端把持久化当不可信边界:类型校验(F3)之外,还须恢复唯一键不变量——三数组统一
    // uniqueBy 首见保留(写端 toggle/restore 有幂等检查,但手工损坏/未来迁移可注入重复键;二轮复审 P2);
    // recent 另与 pushRecent 对齐 RECENT_CAP 截断(M1)
    return {
      schemaVersion: 1,
      favoriteSites: uniqueBy(p.favoriteSites.filter(isFavSite), (f) => f.site),
      favoriteCommands: uniqueBy(p.favoriteCommands.filter(isFavCommand), (f) => f.command),
      recent: uniqueBy(p.recent.filter(isRecentEntry), (r) => r.command).slice(0, RECENT_CAP),
    }
  } catch {
    return emptyPreferences()
  }
}

export function savePreferences(prefs: PreferencesSnapshot, storage?: Storage): void {
  const s = resolveStorage(storage)
  if (!s) return
  try {
    s.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* 配额满 / 隐私模式:静默降级,内存态仍有效 */
  }
}

export function isSiteFavorited(prefs: PreferencesSnapshot, site: string): boolean {
  return prefs.favoriteSites.some((f) => f.site === site)
}

export function isCommandFavorited(prefs: PreferencesSnapshot, command: string): boolean {
  return prefs.favoriteCommands.some((f) => f.command === command)
}

function nextOrder(items: ReadonlyArray<{ order: number }>): number {
  return items.reduce((m, x) => Math.max(m, x.order), -1) + 1
}

export function toggleFavoriteSite(prefs: PreferencesSnapshot, site: string, now: number): PreferencesSnapshot {
  if (isSiteFavorited(prefs, site)) {
    return { ...prefs, favoriteSites: prefs.favoriteSites.filter((f) => f.site !== site) }
  }
  return { ...prefs, favoriteSites: [...prefs.favoriteSites, { site, order: nextOrder(prefs.favoriteSites), createdAt: now }] }
}

export function toggleFavoriteCommand(prefs: PreferencesSnapshot, command: string, site: string, now: number): PreferencesSnapshot {
  if (isCommandFavorited(prefs, command)) {
    return { ...prefs, favoriteCommands: prefs.favoriteCommands.filter((f) => f.command !== command) }
  }
  return { ...prefs, favoriteCommands: [...prefs.favoriteCommands, { command, site, order: nextOrder(prefs.favoriteCommands), createdAt: now }] }
}

export function pushRecent(prefs: PreferencesSnapshot, command: string, at: number): PreferencesSnapshot {
  const rest = prefs.recent.filter((r) => r.command !== command)
  return { ...prefs, recent: [{ command, at }, ...rest].slice(0, RECENT_CAP) }
}

export function staleKeys(prefs: PreferencesSnapshot, commands: CommandManifest[]): { sites: Set<string>; commands: Set<string> } {
  if (commands.length === 0) return { sites: new Set<string>(), commands: new Set<string>() }
  const liveSites = new Set(commands.map((c) => c.site))
  const liveCommands = new Set(commands.map((c) => c.command))
  const sites = new Set(prefs.favoriteSites.filter((f) => !liveSites.has(f.site)).map((f) => f.site))
  const cmds = new Set(prefs.favoriteCommands.filter((f) => !liveCommands.has(f.command)).map((f) => f.command))
  return { sites, commands: cmds }
}

// 撤销回插:原记录原样回插(保 createdAt/order → UI 按 createdAt 排序自然回到原位);已存在则不动(幂等)
export function restoreFavoriteSite(prefs: PreferencesSnapshot, item: FavoriteSite): PreferencesSnapshot {
  if (isSiteFavorited(prefs, item.site)) return prefs
  return { ...prefs, favoriteSites: [...prefs.favoriteSites, item] }
}

export function restoreFavoriteCommand(prefs: PreferencesSnapshot, item: FavoriteCommand): PreferencesSnapshot {
  if (isCommandFavorited(prefs, item.command)) return prefs
  return { ...prefs, favoriteCommands: [...prefs.favoriteCommands, item] }
}
