# P0-C 块 A：收藏与复用 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给命令工作台加两级收藏(常用站点/常用命令)、最近使用一键重跑、localStorage 持久化,全程不碰 HostBridge 契约与 server。

**Architecture:** 三层——纯函数数据层 `src/data/preferences.ts`(可注入 storage/now,可测)→ Zustand `appStore` 新增 preferences 切片(读 prefs、调纯函数、落盘、派生 stale)→ 三处 UI 落点(nav 三分组 / config ☆ / UndoToast)。重跑复用现有 `selectCommand → onRun → buildArgv` 路径,不新造 argv 构造路径;recent 只存 command 键+时间戳,不存参数值,从源头规避脱敏 `••••` 无法回放的问题。

**Tech Stack:** Vite 6 + React 18 + TypeScript(strict) + Zustand 5 + Vitest(jsdom)+ Tailwind v4 CSS 变量。

## Global Constraints

每个 task 的要求都隐含包含本节(逐条 verbatim,来自设计 `docs/specs/2026-07-24-p0-c-a-favorites-design.md`):

- **不碰冻结的 HostBridge 契约**:不改 `commandKey`/`argv`/`RunRequest`/SSE、`src/host/*`、`server/*`、`src/store/runMachine.ts`、`currentRun` 单任务模型。
- **不新造 argv 构造路径**:重跑 = `selectCommand(cmd)` 载入表单 → 用户复核 → 现有 `onRun` → 现有 `buildArgv`。不新增第二条 token 化路径(规避 P0-B 硬前提 #2 的 buildTokens 预填不变式)。
- **recent 不存 values**:只存 `{ command, at }`;重跑靠 `selectCommand` 重填默认值,不复现历史敏感值。
- **持久化只存偏好元数据**:favoriteSites/favoriteCommands/recent 仅含 site/command 键 + 时间戳 + order,**绝不含任何参数值、凭证、token**。
- **纯函数注入依赖**:`preferences.ts` 的时间戳(`now`/`at`)与 `storage` 由调用方注入,函数内不直接 `Date.now()`、不直接摸 `localStorage`(可测)。store action 里才注入 `Date.now()` 与默认 `localStorage`。
- **失效收藏灰显保留**:reconcile 只派生 `stale` 集合,**不删除**持久化数据。
- **排序 createdAt 升序**;`order` 字段照常持久化,P0 不用于排序,供 P1 拖拽复用。
- **常量**:localStorage 键 `opencli-app:prefs:v1`;`RECENT_CAP = 20`;`schemaVersion = 1`。
- **测试门**:`npm test` 全绿;`npm run build`(tsc + vite build)通过;TypeScript strict 无错。
- **验收门**:真实 catalog fuzz(`public/catalog.snapshot.json`,>1000 命令)固化为 Vitest 测试。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/data/preferences.ts` | 新建 | 类型 + 纯函数(load/save/toggle/isFavorited/pushRecent/staleKeys) |
| `src/data/preferences.test.ts` | 新建 | 数据层单测 |
| `src/data/preferences.fuzz.test.ts` | 新建 | 真实 catalog 验收门 |
| `src/store/appStore.ts` | 改 | 新增 preferences 切片(state + actions);beginRun 追加 recent;setCommands 派生 stale |
| `src/store/appStore.test.ts` | 改 | 追加切片单测 |
| `src/features/config/CommandConfig.tsx` | 改 | 标题栏 ☆站点 / ☆命令 |
| `src/features/config/CommandConfig.test.tsx` | 改 | 追加收藏交互测试 |
| `src/features/nav/SiteCommandNav.tsx` | 改 | 「全部站点」之上加 最近/常用站点/常用命令 三分组 + 灰显 |
| `src/features/nav/SiteCommandNav.test.tsx` | 改 | 追加三分组/灰显/重跑测试 |
| `src/components/UndoToast.tsx` | 新建 | 取消收藏的撤销提示(自建,零依赖) |
| `src/components/UndoToast.test.tsx` | 新建 | UndoToast 测试 |
| `src/App.tsx` | 改 | 挂载时 hydratePreferences;渲染 `<UndoToast/>` |
| `src/App.test.tsx` | 改 | 追加 hydrate 测试 |

依赖顺序:Task 1 → 2 →(preferences.ts 完成)→ 3(store)→ 4/5/6(UI,均依赖 store)→ 7(fuzz 门,仅依赖 preferences.ts,置于最后作验收)。

---

### Task 1: 数据层——类型与持久化

**Files:**
- Create: `src/data/preferences.ts`
- Test: `src/data/preferences.test.ts`

**Interfaces:**
- Consumes: `CommandManifest` from `src/data/types.ts`(仅 Task 2/后续用)。
- Produces: `PreferencesSnapshot`、`FavoriteSite`、`FavoriteCommand`、`RecentEntry` 类型;`PREFS_KEY`、`RECENT_CAP` 常量;`emptyPreferences()`、`loadPreferences(storage?)`、`savePreferences(prefs, storage?)`。

- [ ] **Step 1: 写失败测试** `src/data/preferences.test.ts`

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/Lauseusing/Developer/opencli-app-clone && npx vitest run src/data/preferences.test.ts`
Expected: FAIL(模块不存在 / 函数未定义)

- [ ] **Step 3: 写实现** `src/data/preferences.ts`

```ts
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
```

> 注:`CommandManifest` 此 task 未用到,但 Task 2 的 `staleKeys` 会用;import 保留。若 tsc 报 unused,可在 Task 2 前先删本行 import、Task 2 再加回。为避免反复,本 import 允许在 Task 1 暂缺,Task 2 引入。**实现时:Task 1 先不 import `CommandManifest`**,Task 2 再加。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/data/preferences.test.ts`
Expected: PASS(6 项)

- [ ] **Step 5: 提交**

```bash
git add src/data/preferences.ts src/data/preferences.test.ts
git commit -m "feat(prefs): 数据层持久化——PreferencesSnapshot + load/save 往返 + 坏数据回退"
```

---

### Task 2: 数据层——收藏/最近/失效 纯操作

**Files:**
- Modify: `src/data/preferences.ts`(追加函数 + 引入 `CommandManifest` import)
- Test: `src/data/preferences.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的类型与 `RECENT_CAP`。
- Produces: `isSiteFavorited(prefs, site)`、`isCommandFavorited(prefs, command)`、`toggleFavoriteSite(prefs, site, now)`、`toggleFavoriteCommand(prefs, command, site, now)`、`pushRecent(prefs, command, at)`、`staleKeys(prefs, commands)`。全部纯函数、不可变返回。

- [ ] **Step 1: 追加失败测试**(接在 `preferences.test.ts` 末尾)

```ts
import { isSiteFavorited, isCommandFavorited, toggleFavoriteSite, toggleFavoriteCommand, pushRecent, staleKeys, RECENT_CAP } from './preferences'
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/data/preferences.test.ts`
Expected: FAIL(新函数未定义)

- [ ] **Step 3: 追加实现**(在 `preferences.ts` 顶部把 import 改为引入 `CommandManifest`,并在文件末尾追加以下函数)

顶部 import(Task 1 若未加则此时加):
```ts
import type { CommandManifest } from './types'
```

文件末尾追加:
```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/data/preferences.test.ts`
Expected: PASS(11 项)

- [ ] **Step 5: 提交**

```bash
git add src/data/preferences.ts src/data/preferences.test.ts
git commit -m "feat(prefs): 收藏/最近/失效纯操作——toggle 幂等 + pushRecent 去重截断 + staleKeys 派生"
```

---

### Task 3: store preferences 切片

**Files:**
- Modify: `src/store/appStore.ts`
- Test: `src/store/appStore.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1/2 全部导出;现有 `CommandManifest`。
- Produces(store 新增): state `preferences`、`stale`、`lastUndo`;actions `hydratePreferences()`、`toggleSiteFavorite(site)`、`toggleCommandFavorite(cmd)`、`reconcilePreferences()`、`undoLastFavorite()`、`dismissUndo()`;`beginRun` 追加 recent;`setCommands` 派生 stale。

- [ ] **Step 1: 追加失败测试**(接在 `appStore.test.ts` 末尾)

```ts
import { emptyPreferences } from '../data/preferences'

describe('preferences 切片', () => {
  beforeEach(() => { useAppStore.setState(initialState, true); localStorage.clear() })

  test('toggleSiteFavorite 收藏并落盘', () => {
    useAppStore.getState().toggleSiteFavorite('xiaohongshu')
    expect(useAppStore.getState().preferences.favoriteSites.map((f) => f.site)).toEqual(['xiaohongshu'])
    expect(localStorage.getItem('opencli-app:prefs:v1')).toContain('xiaohongshu')
  })

  test('toggleCommandFavorite 存 command+site', () => {
    useAppStore.getState().toggleCommandFavorite(cmd)   // cmd = x/login(文件顶部已定义)
    const fav = useAppStore.getState().preferences.favoriteCommands[0]
    expect(fav.command).toBe('x/login'); expect(fav.site).toBe('x')
  })

  test('取消收藏设置 lastUndo,undoLastFavorite 回滚', () => {
    useAppStore.getState().toggleSiteFavorite('x')       // 收藏
    useAppStore.getState().toggleSiteFavorite('x')       // 取消 → lastUndo
    expect(useAppStore.getState().lastUndo).toEqual({ kind: 'site', site: 'x' })
    useAppStore.getState().undoLastFavorite()
    expect(useAppStore.getState().preferences.favoriteSites.map((f) => f.site)).toEqual(['x'])
    expect(useAppStore.getState().lastUndo).toBeUndefined()
  })

  test('收藏(新增)不设 lastUndo;dismissUndo 清除', () => {
    useAppStore.getState().toggleSiteFavorite('x')
    expect(useAppStore.getState().lastUndo).toBeUndefined()
    useAppStore.setState({ lastUndo: { kind: 'site', site: 'z' } })
    useAppStore.getState().dismissUndo()
    expect(useAppStore.getState().lastUndo).toBeUndefined()
  })

  test('beginRun 追加 recent(运行开始即记)', () => {
    useAppStore.getState().selectCommand(cmd)
    useAppStore.getState().beginRun('r-a')
    expect(useAppStore.getState().preferences.recent[0].command).toBe('x/login')
  })

  test('hydratePreferences 从 localStorage 载入', () => {
    localStorage.setItem('opencli-app:prefs:v1', JSON.stringify({ schemaVersion: 1, favoriteSites: [{ site: 'q', order: 0, createdAt: 1 }], favoriteCommands: [], recent: [] }))
    useAppStore.getState().hydratePreferences()
    expect(useAppStore.getState().preferences.favoriteSites[0].site).toBe('q')
  })

  test('setCommands 后 stale 正确派生(收藏了不存在的命令)', () => {
    useAppStore.getState().toggleCommandFavorite(cmd)                 // x/login
    useAppStore.getState().setCommands([])                            // 空 manifest → 不误灰
    expect(useAppStore.getState().stale.commands.size).toBe(0)
    useAppStore.getState().setCommands([{ command: 'other/x', site: 'other', name: 'x', description: '', access: 'read', browser: false, args: [] }])
    expect(useAppStore.getState().stale.commands.has('x/login')).toBe(true)   // x/login 不在新目录 → stale
  })

  test('hydratePreferences 也重算 stale(命令先到、偏好后到)', () => {
    useAppStore.getState().setCommands([{ command: 'other/x', site: 'other', name: 'x', description: '', access: 'read', browser: false, args: [] }])
    localStorage.setItem('opencli-app:prefs:v1', JSON.stringify({ schemaVersion: 1, favoriteSites: [], favoriteCommands: [{ command: 'x/login', site: 'x', order: 0, createdAt: 1 }], recent: [] }))
    useAppStore.getState().hydratePreferences()
    expect(useAppStore.getState().stale.commands.has('x/login')).toBe(true)
  })
})
```

> `describe` 需在 `appStore.test.ts` 顶部 import:确认首行 `import` 里包含 `describe`(vitest 全局若未启用则显式 import)。本仓 vitest globals 已开(现有测试直接用 `test`),`describe`/`beforeEach` 同为全局,无需额外 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/store/appStore.test.ts`
Expected: FAIL(action 未定义)

- [ ] **Step 3: 改实现** — `src/store/appStore.ts` 完整替换为:

```ts
import { create } from 'zustand'
import type { CommandManifest } from '../data/types'
import type { OutputEvent, DoneEvent } from '../host/types'
import { transition, type RunState } from './runMachine'
import {
  emptyPreferences, loadPreferences, savePreferences,
  toggleFavoriteSite, toggleFavoriteCommand, isSiteFavorited, isCommandFavorited,
  pushRecent, staleKeys, type PreferencesSnapshot,
} from '../data/preferences'

const SENSITIVE = /password|passcode|secret|token|cookie/i

// cmd 暂未参与判定（脱敏仅按字段名正则），但按 brief 接口签名保留形参供未来按 arg 类型细化
export function redactValues(_cmd: CommandManifest, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) out[k] = SENSITIVE.test(k) && !!v ? '••••' : v
  return out
}

export type CommandRun = {
  id: string
  command: CommandManifest
  values: Record<string, unknown>          // 已脱敏
  state: RunState
  startedAt: number
  endedAt?: number
  lines: OutputEvent[]
  result?: Record<string, unknown>[]
  error?: { summary: string; detail?: string }
}

export type LastUndo =
  | { kind: 'site'; site: string }
  | { kind: 'command'; command: string; site: string }

function defaultsOf(cmd: CommandManifest): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const a of cmd.args) if (a.default !== undefined) v[a.name] = a.default
  return v
}

function isTerminal(s: RunState): boolean {
  return s === 'succeeded' || s === 'failed' || s === 'cancelled'
}

type AppState = {
  commands: CommandManifest[]
  setCommands: (cmds: CommandManifest[]) => void
  catalogStatus: 'loading' | 'ready' | 'error'
  catalogError?: string
  setCatalogStatus: (status: 'loading' | 'ready' | 'error', error?: string) => void
  selected?: CommandManifest
  values: Record<string, unknown>
  selectCommand: (cmd: CommandManifest) => void
  setValue: (name: string, value: unknown) => void
  currentRun?: CommandRun
  beginRun: (runId: string) => void
  appendOutput: (e: OutputEvent) => void
  finishRun: (e: DoneEvent) => void
  markCancelling: () => void
  mode: 'demo' | 'connected'
  setMode: (mode: 'demo' | 'connected') => void
  // —— preferences 切片 ——
  preferences: PreferencesSnapshot
  stale: { sites: Set<string>; commands: Set<string> }
  lastUndo?: LastUndo
  hydratePreferences: () => void
  toggleSiteFavorite: (site: string) => void
  toggleCommandFavorite: (cmd: CommandManifest) => void
  reconcilePreferences: () => void
  undoLastFavorite: () => void
  dismissUndo: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  commands: [],
  setCommands: (commands) => set((s) => ({
    commands, catalogStatus: 'ready', catalogError: undefined,
    stale: staleKeys(s.preferences, commands),
  })),
  catalogStatus: 'loading',
  catalogError: undefined,
  setCatalogStatus: (status, error) => set({ catalogStatus: status, catalogError: error }),
  selected: undefined,
  values: {},
  selectCommand: (cmd) => set({ selected: cmd, values: defaultsOf(cmd) }),
  setValue: (name, value) => set((s) => ({ values: { ...s.values, [name]: value } })),
  currentRun: undefined,
  beginRun: (runId) => {
    const cmd = get().selected
    if (!cmd) return
    const preferences = pushRecent(get().preferences, cmd.command, Date.now())
    savePreferences(preferences)
    set({
      preferences,
      currentRun: {
        id: runId, command: cmd, values: redactValues(cmd, get().values),
        state: transition(transition('idle', { type: 'RUN' }), { type: 'VALID' }), // →starting
        startedAt: Date.now(), lines: [],
      },
    })
  },
  appendOutput: (e) => set((s) => {
    if (!s.currentRun || s.currentRun.id !== e.runId || isTerminal(s.currentRun.state)) return s
    if (s.currentRun.lines.some((l) => l.seq === e.seq)) return s
    const lines = [...s.currentRun.lines, e].sort((a, b) => a.seq - b.seq)
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'OUTPUT' }), lines } }
  }),
  finishRun: (e) => set((s) => {
    if (!s.currentRun || s.currentRun.id !== e.runId || isTerminal(s.currentRun.state)) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'DONE', outcome: e.outcome }), endedAt: e.at, result: e.result, error: e.error } }
  }),
  markCancelling: () => set((s) => {
    if (!s.currentRun) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'CANCEL' }) } }
  }),
  mode: 'demo',
  setMode: (mode) => set({ mode }),
  // —— preferences 切片 ——
  preferences: emptyPreferences(),
  stale: { sites: new Set<string>(), commands: new Set<string>() },
  lastUndo: undefined,
  hydratePreferences: () => set((s) => {
    const preferences = loadPreferences()
    return { preferences, stale: staleKeys(preferences, s.commands) }
  }),
  toggleSiteFavorite: (site) => set((s) => {
    const wasFav = isSiteFavorited(s.preferences, site)
    const preferences = toggleFavoriteSite(s.preferences, site, Date.now())
    savePreferences(preferences)
    return { preferences, stale: staleKeys(preferences, s.commands), lastUndo: wasFav ? { kind: 'site', site } : undefined }
  }),
  toggleCommandFavorite: (cmd) => set((s) => {
    const wasFav = isCommandFavorited(s.preferences, cmd.command)
    const preferences = toggleFavoriteCommand(s.preferences, cmd.command, cmd.site, Date.now())
    savePreferences(preferences)
    return { preferences, stale: staleKeys(preferences, s.commands), lastUndo: wasFav ? { kind: 'command', command: cmd.command, site: cmd.site } : undefined }
  }),
  reconcilePreferences: () => set((s) => ({ stale: staleKeys(s.preferences, s.commands) })),
  undoLastFavorite: () => set((s) => {
    const u = s.lastUndo
    if (!u) return s
    const preferences = u.kind === 'site'
      ? toggleFavoriteSite(s.preferences, u.site, Date.now())
      : toggleFavoriteCommand(s.preferences, u.command, u.site, Date.now())
    savePreferences(preferences)
    return { preferences, stale: staleKeys(preferences, s.commands), lastUndo: undefined }
  }),
  dismissUndo: () => set({ lastUndo: undefined }),
}))
```

- [ ] **Step 4: 跑测试确认通过(含现有全绿)**

Run: `npx vitest run src/store/appStore.test.ts`
Expected: PASS(现有 + 新增 8 项)

- [ ] **Step 5: 提交**

```bash
git add src/store/appStore.ts src/store/appStore.test.ts
git commit -m "feat(store): preferences 切片——收藏/最近/stale + lastUndo 撤销;beginRun 记 recent、setCommands 派生 stale"
```

---

### Task 4: CommandConfig 标题栏收藏动作

**Files:**
- Modify: `src/features/config/CommandConfig.tsx`
- Test: `src/features/config/CommandConfig.test.tsx`(追加)

**Interfaces:**
- Consumes: store `preferences`、`toggleSiteFavorite`、`toggleCommandFavorite`;`isSiteFavorited`/`isCommandFavorited`。
- Produces: `data-testid="fav-site"`、`data-testid="fav-command"` 两个按钮,实心 ★/描边 ☆ 随收藏态。

- [ ] **Step 1: 追加失败测试**(接在 `CommandConfig.test.tsx` 末尾)

```ts
import { emptyPreferences } from '../../data/preferences'

describe('收藏动作', () => {
  beforeEach(() => { useAppStore.setState({ selected: cmd, values: {}, currentRun: undefined, preferences: emptyPreferences(), stale: { sites: new Set(), commands: new Set() } }); localStorage.clear() })

  test('点 ☆站点 收藏并变实心', async () => {
    render(<CommandConfig onRun={() => {}} />)
    const btn = screen.getByTestId('fav-site')
    expect(btn).toHaveTextContent('☆')
    await userEvent.click(btn)
    expect(useAppStore.getState().preferences.favoriteSites.map((f) => f.site)).toEqual(['x'])
    expect(screen.getByTestId('fav-site')).toHaveTextContent('★')
  })

  test('点 ☆命令 收藏 command+site', async () => {
    render(<CommandConfig onRun={() => {}} />)
    await userEvent.click(screen.getByTestId('fav-command'))
    const fav = useAppStore.getState().preferences.favoriteCommands[0]
    expect(fav.command).toBe('x/go'); expect(fav.site).toBe('x')
    expect(screen.getByTestId('fav-command')).toHaveTextContent('★')
  })
})
```

> `cmd` 在文件顶部已定义为 `x/go`(site `x`)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/features/config/CommandConfig.test.tsx`
Expected: FAIL(找不到 fav-site)

- [ ] **Step 3: 改实现** — `src/features/config/CommandConfig.tsx`,在现有基础上:
  1. import 增加 store 收藏 action 与判定函数;
  2. 替换标题两行(原第 33-38 行)为带 ☆ 的版本。

顶部 import 段替换为:
```tsx
import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { commandPreview } from '../../data/command'
import { isSiteFavorited, isCommandFavorited } from '../../data/preferences'
import { validate } from './validation'
import { DynamicField } from './DynamicField'
```

组件内、`const [errors...]` 之后补订阅:
```tsx
  const preferences = useAppStore((s) => s.preferences)
  const toggleSiteFavorite = useAppStore((s) => s.toggleSiteFavorite)
  const toggleCommandFavorite = useAppStore((s) => s.toggleCommandFavorite)
```

把原标题两行(`<div className="mb-1 text-xs" ...>{selected.site} / {selected.name}</div>` 与其下的 `<div className="mb-1 flex items-center gap-2">...</div>`)整体替换为:
```tsx
      <div className="mb-1 flex items-center gap-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
        <span>{selected.site}</span>
        <button
          data-testid="fav-site"
          onClick={() => toggleSiteFavorite(selected.site)}
          aria-pressed={isSiteFavorited(preferences, selected.site)}
          title={isSiteFavorited(preferences, selected.site) ? '取消收藏站点' : '收藏站点'}
          style={{ color: isSiteFavorited(preferences, selected.site) ? 'var(--color-warning)' : 'var(--color-fg-dim)', lineHeight: 1 }}
        >
          {isSiteFavorited(preferences, selected.site) ? '★' : '☆'}
        </button>
        <span>/ {selected.name}</span>
      </div>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-lg font-semibold">{selected.name}</h2>
        <button
          data-testid="fav-command"
          onClick={() => toggleCommandFavorite(selected)}
          aria-pressed={isCommandFavorited(preferences, selected.command)}
          title={isCommandFavorited(preferences, selected.command) ? '取消收藏命令' : '收藏命令'}
          style={{ color: isCommandFavorited(preferences, selected.command) ? 'var(--color-warning)' : 'var(--color-fg-dim)', lineHeight: 1 }}
        >
          {isCommandFavorited(preferences, selected.command) ? '★' : '☆'}
        </button>
        <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--color-hover)', color: selected.access === 'write' ? 'var(--color-warning)' : 'var(--color-fg-dim)' }}>{selected.access}</span>
        {selected.browser && <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--color-hover)', color: 'var(--color-fg-dim)' }}>浏览器</span>}
      </div>
```

- [ ] **Step 4: 跑测试确认通过(含现有全绿)**

Run: `npx vitest run src/features/config/CommandConfig.test.tsx`
Expected: PASS(现有 5 项 + 新增 2 项)

- [ ] **Step 5: 提交**

```bash
git add src/features/config/CommandConfig.tsx src/features/config/CommandConfig.test.tsx
git commit -m "feat(config): 标题栏 ☆站点 / ☆命令 两级收藏动作(实心/描边随态)"
```

---

### Task 5: SiteCommandNav 三分组 + 灰显

**Files:**
- Modify: `src/features/nav/SiteCommandNav.tsx`(整体替换)
- Test: `src/features/nav/SiteCommandNav.test.tsx`(追加)

**Interfaces:**
- Consumes: store `preferences`、`stale`、`selectCommand`、`commands`。
- Produces: `data-testid` = `group-recent` / `group-fav-sites` / `group-fav-commands`;失效项灰显(`opacity:0.4` + `disabled`);常用站点点击 `setQ(site)` 进目录;最近/常用命令点击 `selectCommand`。

- [ ] **Step 1: 追加失败测试**(接在 `SiteCommandNav.test.tsx` 末尾)

```ts
import { emptyPreferences } from '../../data/preferences'

describe('收藏与最近分组', () => {
  const cmds = [c('12306', 'login'), c('12306', 'orders'), c('xiaohongshu', 'download')]
  beforeEach(() => {
    useAppStore.setState({
      commands: cmds, selected: undefined, values: {},
      preferences: { schemaVersion: 1, favoriteSites: [{ site: 'xiaohongshu', order: 0, createdAt: 1 }], favoriteCommands: [{ command: '12306/login', site: '12306', order: 0, createdAt: 2 }], recent: [{ command: 'xiaohongshu/download', at: 3 }] },
      stale: { sites: new Set(), commands: new Set() },
    })
  })

  test('渲染三分组', () => {
    render(<SiteCommandNav />)
    expect(screen.getByTestId('group-recent')).toBeInTheDocument()
    expect(screen.getByTestId('group-fav-sites')).toBeInTheDocument()
    expect(screen.getByTestId('group-fav-commands')).toBeInTheDocument()
  })

  test('点最近项 → selectCommand 载入表单', async () => {
    render(<SiteCommandNav />)
    const recent = screen.getByTestId('group-recent')
    await userEvent.click(within(recent).getByText('download'))
    expect(useAppStore.getState().selected?.command).toBe('xiaohongshu/download')
  })

  test('点常用站点 → setQ 进该站点目录', async () => {
    render(<SiteCommandNav />)
    await userEvent.click(screen.getByTestId('fav-site-nav-xiaohongshu'))
    expect((screen.getByTestId('nav-search') as HTMLInputElement).value).toBe('xiaohongshu')
  })

  test('失效收藏灰显且禁用', () => {
    useAppStore.setState({ stale: { sites: new Set(), commands: new Set(['12306/login']) } })
    render(<SiteCommandNav />)
    const group = screen.getByTestId('group-fav-commands')
    const btn = within(group).getByText('12306 · login').closest('button')!
    expect(btn).toBeDisabled()
  })

  test('搜索时隐藏分组(q 非空)', async () => {
    render(<SiteCommandNav />)
    await userEvent.type(screen.getByTestId('nav-search'), 'download')
    expect(screen.queryByTestId('group-recent')).not.toBeInTheDocument()
  })
})
```

> 顶部 import 需加 `within`:把首行改为 `import { render, screen, within } from '@testing-library/react'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/features/nav/SiteCommandNav.test.tsx`
Expected: FAIL(找不到 group-recent)

- [ ] **Step 3: 整体替换** `src/features/nav/SiteCommandNav.tsx`:

```tsx
import { useMemo, useState, type ReactNode } from 'react'
import { useAppStore } from '../../store/appStore'
import { searchCommands, groupBySite } from '../../data/catalog'
import type { CommandManifest } from '../../data/types'

function NavCommandButton({ label, cmd, stale, active, onClick }: {
  label: string; cmd?: CommandManifest; stale: boolean; active: boolean; onClick: () => void
}) {
  const disabled = !cmd
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={stale ? '该命令在当前目录中已不存在' : undefined}
      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm"
      style={{ background: active ? 'var(--color-hover)' : 'transparent', color: 'var(--color-fg)', opacity: stale ? 0.4 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      <span className="truncate">{label}</span>
      {cmd && <span className="text-xs" style={{ color: cmd.access === 'write' ? 'var(--color-warning)' : 'var(--color-fg-dim)' }}>{cmd.access}</span>}
    </button>
  )
}

function NavSection({ title, testid, children }: { title: string; testid: string; children: ReactNode }) {
  return (
    <div className="mb-3" data-testid={testid}>
      <div className="px-2 py-1 text-xs uppercase tracking-wide" style={{ color: 'var(--color-fg-dim)' }}>{title}</div>
      {children}
    </div>
  )
}

export function SiteCommandNav() {
  const commands = useAppStore((s) => s.commands)
  const selected = useAppStore((s) => s.selected)
  const selectCommand = useAppStore((s) => s.selectCommand)
  const preferences = useAppStore((s) => s.preferences)
  const stale = useAppStore((s) => s.stale)
  const [q, setQ] = useState('')

  const groups = useMemo(() => groupBySite(searchCommands(commands, q)), [commands, q])
  const byKey = useMemo(() => new Map(commands.map((c) => [c.command, c])), [commands])
  const favSites = useMemo(() => [...preferences.favoriteSites].sort((a, b) => a.createdAt - b.createdAt), [preferences.favoriteSites])
  const favCommands = useMemo(() => [...preferences.favoriteCommands].sort((a, b) => a.createdAt - b.createdAt), [preferences.favoriteCommands])
  const recent = preferences.recent
  const showGroups = q.trim() === '' && (recent.length + favSites.length + favCommands.length) > 0

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <input
          data-testid="nav-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索服务或命令"
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
        />
      </div>
      <nav className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {showGroups && (
          <>
            {recent.length > 0 && (
              <NavSection title="最近使用" testid="group-recent">
                {recent.map((r) => {
                  const cmd = byKey.get(r.command)
                  return (
                    <NavCommandButton key={r.command} label={cmd ? cmd.name : r.command} cmd={cmd} stale={!cmd}
                      active={selected?.command === r.command} onClick={() => cmd && selectCommand(cmd)} />
                  )
                })}
              </NavSection>
            )}
            {favSites.length > 0 && (
              <NavSection title="常用站点" testid="group-fav-sites">
                {favSites.map((f) => {
                  const dead = stale.sites.has(f.site)
                  return (
                    <button key={f.site} data-testid={`fav-site-nav-${f.site}`}
                      onClick={() => setQ(f.site)} disabled={dead}
                      title={dead ? '该站点在当前目录中已不存在' : undefined}
                      className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm"
                      style={{ background: 'transparent', color: 'var(--color-fg)', opacity: dead ? 0.4 : 1, cursor: dead ? 'not-allowed' : 'pointer' }}>
                      {f.site}
                    </button>
                  )
                })}
              </NavSection>
            )}
            {favCommands.length > 0 && (
              <NavSection title="常用命令" testid="group-fav-commands">
                {favCommands.map((f) => {
                  const cmd = byKey.get(f.command)
                  const dead = !cmd || stale.commands.has(f.command)
                  return (
                    <NavCommandButton key={f.command} label={cmd ? `${cmd.site} · ${cmd.name}` : f.command} cmd={cmd} stale={dead}
                      active={selected?.command === f.command} onClick={() => cmd && selectCommand(cmd)} />
                  )
                })}
              </NavSection>
            )}
            <div className="px-2 py-1 text-xs uppercase tracking-wide" style={{ color: 'var(--color-fg-dim)' }}>全部站点</div>
          </>
        )}
        {groups.map((g) => (
          <div key={g.site} className="mb-3">
            <div className="px-2 py-1 text-xs uppercase tracking-wide" style={{ color: 'var(--color-fg-dim)' }}>{g.site}</div>
            {g.commands.map((cmd) => {
              const active = selected?.command === cmd.command
              return (
                <button
                  key={cmd.command}
                  onClick={() => selectCommand(cmd)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm"
                  style={{ background: active ? 'var(--color-hover)' : 'transparent', color: 'var(--color-fg)' }}
                >
                  <span>{cmd.name}</span>
                  <span className="text-xs" style={{ color: cmd.access === 'write' ? 'var(--color-warning)' : 'var(--color-fg-dim)' }}>{cmd.access}</span>
                </button>
              )
            })}
          </div>
        ))}
        {groups.length === 0 && <div className="px-3 py-2 text-sm" style={{ color: 'var(--color-fg-dim)' }}>无匹配命令</div>}
      </nav>
    </div>
  )
}
```

> 现有 3 个 nav 测试仍应通过:它们的 beforeEach 只 partial-set `commands`,`preferences` 保持 store 初始 `emptyPreferences()` → `showGroups=false` → 只渲染「全部站点」列表,`getByText('12306')`/`getByText('download')` 各命中一次不歧义。

- [ ] **Step 4: 跑测试确认通过(含现有全绿)**

Run: `npx vitest run src/features/nav/SiteCommandNav.test.tsx`
Expected: PASS(现有 3 项 + 新增 5 项)

- [ ] **Step 5: 提交**

```bash
git add src/features/nav/SiteCommandNav.tsx src/features/nav/SiteCommandNav.test.tsx
git commit -m "feat(nav): 全部站点之上加 最近/常用站点/常用命令 三分组 + 失效灰显 + 一键重跑载入表单"
```

---

### Task 6: UndoToast + App 挂载接线

**Files:**
- Create: `src/components/UndoToast.tsx`
- Create: `src/components/UndoToast.test.tsx`
- Modify: `src/App.tsx`
- Test: `src/App.test.tsx`(追加)

**Interfaces:**
- Consumes: store `lastUndo`、`undoLastFavorite`、`dismissUndo`、`hydratePreferences`。
- Produces: `data-testid="undo-toast"`、`data-testid="undo-button"`;App 挂载时调用 `hydratePreferences()` 一次。

- [ ] **Step 1: 写失败测试** `src/components/UndoToast.test.tsx`

```ts
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UndoToast } from './UndoToast'
import { useAppStore } from '../store/appStore'

const initialState = useAppStore.getState()
beforeEach(() => { useAppStore.setState(initialState, true); localStorage.clear() })

test('lastUndo 为空时不渲染', () => {
  render(<UndoToast />)
  expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument()
})

test('取消站点收藏后显示 toast,点撤销回滚', async () => {
  useAppStore.getState().toggleSiteFavorite('x')   // 收藏
  useAppStore.getState().toggleSiteFavorite('x')   // 取消 → lastUndo
  render(<UndoToast />)
  expect(screen.getByTestId('undo-toast')).toBeInTheDocument()
  await userEvent.click(screen.getByTestId('undo-button'))
  expect(useAppStore.getState().preferences.favoriteSites.map((f) => f.site)).toEqual(['x'])
  expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/UndoToast.test.tsx`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 写实现** `src/components/UndoToast.tsx`

```tsx
import { useEffect } from 'react'
import { useAppStore } from '../store/appStore'

const AUTO_DISMISS_MS = 5000

export function UndoToast() {
  const lastUndo = useAppStore((s) => s.lastUndo)
  const undo = useAppStore((s) => s.undoLastFavorite)
  const dismiss = useAppStore((s) => s.dismissUndo)

  useEffect(() => {
    if (!lastUndo) return
    const id = setTimeout(dismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(id)
  }, [lastUndo, dismiss])

  if (!lastUndo) return null
  const label = lastUndo.kind === 'site'
    ? `已取消收藏站点 ${lastUndo.site}`
    : `已取消收藏命令 ${lastUndo.command}`

  return (
    <div
      data-testid="undo-toast"
      className="fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg px-4 py-2 text-sm shadow-lg"
      style={{ background: 'var(--color-panel)', color: 'var(--color-fg)', border: '1px solid var(--color-line)' }}
    >
      <span>{label}</span>
      <button data-testid="undo-button" onClick={undo} style={{ color: 'var(--color-accent)' }}>撤销</button>
    </div>
  )
}
```

- [ ] **Step 4: 跑 UndoToast 测试确认通过**

Run: `npx vitest run src/components/UndoToast.test.tsx`
Expected: PASS(3 项)

- [ ] **Step 5: 改 App.tsx** — 挂载 hydrate + 渲染 toast。

import 段补一行:
```tsx
import { UndoToast } from './components/UndoToast'
```

在组件体内、现有 `useEffect(...)` 之后补一个只跑一次的 effect:
```tsx
  useEffect(() => { useAppStore.getState().hydratePreferences() }, [])
```

把返回的根 `<div data-testid="app-root" className="h-full">…</div>` 内、`<AppShell .../>` 之后补 `<UndoToast/>`:
```tsx
  return (
    <div data-testid="app-root" className="h-full">
      <AppShell
        nav={<SiteCommandNav />}
        config={<CommandConfig onRun={onRun} />}
        runs={<RunPanel onCancel={onCancel} />}
        catalogStatus={catalogStatus}
        catalogError={catalogError}
        onRetryCatalog={() => { setCatalogStatus('loading'); fetchCatalog() }}
      />
      <UndoToast />
    </div>
  )
```

- [ ] **Step 6: 追加 App 测试**(接在 `App.test.tsx` 末尾)

```ts
test('挂载时 hydratePreferences 从 localStorage 载入收藏', () => {
  localStorage.setItem('opencli-app:prefs:v1', JSON.stringify({ schemaVersion: 1, favoriteSites: [{ site: 'seeded', order: 0, createdAt: 1 }], favoriteCommands: [], recent: [] }))
  render(<App />)
  expect(useAppStore.getState().preferences.favoriteSites[0].site).toBe('seeded')
})
```

- [ ] **Step 7: 跑测试确认通过(含现有全绿)**

Run: `npx vitest run src/App.test.tsx src/components/UndoToast.test.tsx`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/components/UndoToast.tsx src/components/UndoToast.test.tsx src/App.tsx src/App.test.tsx
git commit -m "feat(app): UndoToast 撤销提示(自建,5s 自动消失)+ 挂载时 hydratePreferences"
```

---

### Task 7: 真实 catalog fuzz 验收门

**Files:**
- Create: `src/data/preferences.fuzz.test.ts`

**Interfaces:**
- Consumes: Task 1/2 全部导出;真实快照 `public/catalog.snapshot.json`(>1000 命令,由 `npm run sync-catalog` 生成)。
- Produces: CI 中的确定性 fuzz 断言(不抛、无键碰撞、stale 与 manifest 一致)。

- [ ] **Step 1: 写测试** `src/data/preferences.fuzz.test.ts`

```ts
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
```

- [ ] **Step 2: 跑测试确认通过**

Run: `npx vitest run src/data/preferences.fuzz.test.ts`
Expected: PASS(3 项)。若 `public/catalog.snapshot.json` 缺失,先跑 `npm run sync-catalog` 生成。

- [ ] **Step 3: 全量测试 + 构建门**

Run: `npm test && npm run build`
Expected: 全部 PASS;tsc 无类型错;vite build 成功。

- [ ] **Step 4: 提交**

```bash
git add src/data/preferences.fuzz.test.ts
git commit -m "test(prefs): 真实 catalog fuzz 验收门——>1000 命令 toggle/recent/stale 一致性"
```

---

## Self-Review(计划自检)

**1. Spec 覆盖:** 设计 §5 纯函数(Task 1+2)/§6 store(Task 3)/§7.1 nav 三分组(Task 5)/§7.2 config ☆(Task 4)/§7.3 UndoToast(Task 6)/§10 测试策略(各 task 测试 + Task 7 fuzz)/§11 验收(全部映射)。无遗漏。

**2. Placeholder 扫描:** 无 TBD/TODO/"类似上文";每个代码步骤含完整可运行代码。`- [ ]` 为步骤 checkbox,非占位符。

**3. 类型一致性:**
- `toggleFavoriteSite(prefs, site, now)` / `toggleFavoriteCommand(prefs, command, site, now)`(Task 2)↔ store `toggleSiteFavorite(site)` / `toggleCommandFavorite(cmd)` 内注入 `Date.now()` 调用(Task 3)—— 一致。
- `staleKeys(prefs, commands)` 返回 `{ sites: Set<string>; commands: Set<string> }`(Task 2)↔ store `stale` 字段类型(Task 3)↔ nav `stale.sites.has()`/`stale.commands.has()`(Task 5)—— 一致。
- `LastUndo` 联合类型(Task 3)↔ UndoToast `lastUndo.kind` 判别(Task 6)—— 一致。
- `PreferencesSnapshot`/`RECENT_CAP` 全 task 引用同一导出。
- 真实 API 名核对:`buildArgv`(非 buildTokens)、`commandPreview(cmd, values)`、`selectCommand`、`beginRun` —— 均与仓内现状一致;A 不改这些,仅新增。

**4. 破坏面自检:** beginRun 追加 `savePreferences`(localStorage 副作用)→ 现有 store/App 测试不读回 prefs,断言不受影响;nav/config 现有测试因 `preferences` 保持空而走原路径。已在对应 task 注明。

---

## Execution Handoff

计划已存 `docs/plans/2026-07-24-p0-c-a-favorites.md`。按本项目既定工作流:**subagent-driven-development**(fast-worker 实现 + 两段式 review 门 + 真实 catalog fuzz),沿用 P0-A/P0-B 模式。分支已建 `p0-c-a-favorites`(设计文档 commit 5e26b7b)。
