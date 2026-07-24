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
  return typeof localStorage !== 'undefined' ? localStorage : undefined
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
    return { schemaVersion: 1, favoriteSites: p.favoriteSites, favoriteCommands: p.favoriteCommands, recent: p.recent }
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
