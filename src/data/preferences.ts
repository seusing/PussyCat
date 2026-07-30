import type { CommandManifest } from './types'

export const PREFS_KEY = 'opencli-app:prefs:v1'          // v1:只读遗留 key,仅供迁移读取,不再写入
export const PREFS_KEY_V2 = 'opencli-app:prefs:v2'
export const RECENT_CAP = 20

export type FavoriteSite = { site: string; order: number; createdAt: number }
export type FavoriteCommand = { command: string; site: string; order: number; createdAt: number }
export type RecentEntry = { command: string; at: number }
// 落盘白名单:恰好这三个字段(I-P7)。commandKey/fingerprint/acknowledgedAt 之外一律不得进入
// 持久化 —— 尤其是 values/argv/result/error/detail,它们属于运行期数据,不属于"我确认过这条策略"这件事。
export type Acknowledgement = { commandKey: string; fingerprint: string; acknowledgedAt: number }

export type PreferencesSnapshot = {
  schemaVersion: 1
  favoriteSites: FavoriteSite[]
  favoriteCommands: FavoriteCommand[]
  recent: RecentEntry[]
  acknowledgements: Acknowledgement[]
}

export function emptyPreferences(): PreferencesSnapshot {
  return { schemaVersion: 1, favoriteSites: [], favoriteCommands: [], recent: [], acknowledgements: [] }
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
// 只认三个白名单字段,即使原始项夹带 values/argv/result/error/detail 等运行期字段,
// 重建时也一律丢弃(I-P7 的落盘守卫;见 preferences.test.ts 的守卫用例)。
function isAcknowledgement(x: unknown): x is Acknowledgement {
  const o = x as Acknowledgement
  return !!o && typeof o === 'object' && typeof o.commandKey === 'string' && typeof o.fingerprint === 'string' && isFiniteNum(o.acknowledgedAt)
}
function toCleanAcknowledgement(a: Acknowledgement): Acknowledgement {
  return { commandKey: a.commandKey, fingerprint: a.fingerprint, acknowledgedAt: a.acknowledgedAt }
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

// 迁移期兼容:早期/手工构造的收藏项可能缺 order(见 preferences.test.ts 的 v1 迁移与 v2 坏项两条夹具)。
// 按数组下标补一个稳定序,不影响其余字段的既有校验(isFavSite/isFavCommand 仍会拒绝缺 site/command/createdAt 的项)。
function backfillOrder(item: unknown, index: number): unknown {
  if (!item || typeof item !== 'object') return item
  const o = item as Record<string, unknown>
  return isFiniteNum(o.order) ? item : { ...o, order: index }
}

// 归一化一份"看起来像 PreferencesSnapshot"的原始 JSON。
// schemaVersion 缺失视为可接受(遗留数据/精简夹具);**存在但不等于 1** 才判定整份无效——
// 与「loadPreferences:schemaVersion 不符→empty」的既有约束一致,只是放宽了"完全没写这个字段"的情形。
function normalizeSnapshot(raw: unknown): PreferencesSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, unknown>
  if (p.schemaVersion !== undefined && p.schemaVersion !== 1) return undefined
  if (!Array.isArray(p.favoriteSites) || !Array.isArray(p.favoriteCommands) || !Array.isArray(p.recent)) return undefined
  const rawSites: unknown[] = p.favoriteSites
  const rawCommands: unknown[] = p.favoriteCommands
  const rawRecent: unknown[] = p.recent
  const rawAcks: unknown[] = Array.isArray(p.acknowledgements) ? p.acknowledgements : []
  return {
    schemaVersion: 1,
    favoriteSites: uniqueBy(rawSites.map(backfillOrder).filter(isFavSite), (f) => f.site),
    favoriteCommands: uniqueBy(rawCommands.map(backfillOrder).filter(isFavCommand), (f) => f.command),
    recent: uniqueBy(rawRecent.filter(isRecentEntry), (r) => r.command).slice(0, RECENT_CAP),
    acknowledgements: uniqueBy(rawAcks.filter(isAcknowledgement).map(toCleanAcknowledgement), (a) => a.commandKey),
  }
}

function readRaw(s: Storage, key: string): PreferencesSnapshot | undefined {
  try {
    const raw = s.getItem(key)
    if (!raw) return undefined
    return normalizeSnapshot(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function tryWrite(s: Storage, key: string, prefs: PreferencesSnapshot): boolean {
  try {
    s.setItem(key, JSON.stringify(prefs))
    return true
  } catch {
    return false   // 配额满 / 隐私模式:静默降级,内存态仍有效(调用方决定要不要提示"本次会话有效")
  }
}

export function loadPreferences(storage?: Storage): PreferencesSnapshot {
  const s = resolveStorage(storage)
  if (!s) return emptyPreferences()
  const v2 = readRaw(s, PREFS_KEY_V2)
  if (v2) return v2
  // v2 无数据:读 v1 归一化后写回 v2(一次性迁移);v1 之后只读,不再写入
  const migrated = readRaw(s, PREFS_KEY)
  if (migrated) {
    tryWrite(s, PREFS_KEY_V2, migrated)
    return migrated
  }
  return emptyPreferences()
}

export function savePreferences(prefs: PreferencesSnapshot, storage?: Storage): boolean {
  const s = resolveStorage(storage)
  if (!s) return false
  return tryWrite(s, PREFS_KEY_V2, prefs)
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

// —— acknowledgement 管理(Task 8) ——
// 同一 commandKey 只保留最新一条:指纹变化即整条覆盖,不堆积历史确认记录。
export function acknowledge(prefs: PreferencesSnapshot, commandKey: string, fingerprint: string, now: number): PreferencesSnapshot {
  const rest = prefs.acknowledgements.filter((a) => a.commandKey !== commandKey)
  return { ...prefs, acknowledgements: [...rest, { commandKey, fingerprint, acknowledgedAt: now }] }
}

export function revokeAcknowledgement(prefs: PreferencesSnapshot, commandKey: string): PreferencesSnapshot {
  return { ...prefs, acknowledgements: prefs.acknowledgements.filter((a) => a.commandKey !== commandKey) }
}

// 确认与 fingerprint 绑定:策略/审定形状一变,旧确认对新 fingerprint 即失效(I-P5:防陈旧 UI,不是安全授权)。
export function isAcknowledged(prefs: PreferencesSnapshot, commandKey: string, fingerprint: string): boolean {
  return prefs.acknowledgements.some((a) => a.commandKey === commandKey && a.fingerprint === fingerprint)
}
