# P0-C 块 A：收藏与复用（Favorites & Reuse）设计

> 状态：已定稿，待转 writing-plans。
> 基线：main @ 261a3c3（P0-B 完成，工作区干净）。
> 关联 RE：`Documents/Codex/2026-07-22/xz/work/opencliapp-re/RE/06-favorites-cancel-and-feature-roadmap.md`（§1.1 两级收藏、§2 持久化模型、§4 P0 优先级、§5 验收）。

## 1. 背景与范围

P0-C（工作台增强）拆成三块自包含单元；本文只覆盖 **块 A：收藏与复用**。A 引入一个**独立的 `preferences` 状态切片**，是本项目里爆炸半径最小的一块：

- **不碰**冻结的 HostBridge 契约（`mockHost`/`nodeBridgeHost`/`tauriHost`）。
- **不碰** server（`server/*.mjs`）。
- **不碰**运行时状态机（`runMachine.ts`）与 `currentRun` 单任务模型。
- 纯前端：新增一个纯函数数据层 + Zustand store 的一个切片 + 三处 UI 落点。

**A 的产出（对应 RE §4 P0 的 1/2/5）：**
1. 两级收藏：常用站点（收藏 `site`）+ 常用命令（收藏 `site+command`），localStorage 持久化。
2. 最近使用：记录最近运行过的命令，一键重跑。
3. 收藏/最近三个分组出现在左侧导航「全部站点」之上。
4. 命令标题栏出现两个独立收藏动作（☆站点 / ☆命令）。
5. 取消收藏时给一个短暂「撤销」提示。

**不在 A（属块 B/C，见 §9 YAGNI）：** 复制命令/结果、错误详情展开、Catalog 真实刷新、键盘闭环、任务中心、参数预设、Ctrl+K 命令面板。

## 2. 三项已定决策（用户已确认）

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| ① | 最近项「重跑」语义 | **载入表单**（点击最近项 → `selectCommand` 填默认值 → 用户复核 → 运行），**非直接运行** | 历史里的敏感参数被脱敏成 `••••` 无法回放；且 recent **根本不存 values**，只存 `command` 键，从源头规避回放问题 |
| ② | manifest 更新后失效收藏 | **灰显保留 + 标记**（reconcile 产出派生的 stale 集合，**不删除**收藏项） | 站点/命令可能临时下线又回来；删除会丢用户意图 |
| ③ | 收藏排序 | **按 createdAt 升序**（稳定插入序）；拖拽排序留 P1 | P0 不做拖拽；`order` 字段仍持久化，供 P1 拖拽复用 |

## 3. 数据模型

localStorage 键：`opencli-app:prefs:v1`（带 schemaVersion，未来迁移可判版本）。

```ts
export type FavoriteSite = { site: string; order: number; createdAt: number }
export type FavoriteCommand = { command: string; site: string; order: number; createdAt: number }
export type RecentEntry = { command: string; at: number }

export type PreferencesSnapshot = {
  schemaVersion: 1
  favoriteSites: FavoriteSite[]
  favoriteCommands: FavoriteCommand[]
  recent: RecentEntry[]   // 最近在前，去重，上限 20
}
```

**数据规则：**
- 站点唯一键：`site`；命令唯一键：`command`（即 "site/name"）。
- `recent` 去重（同 command 再运行 → 旧项移除、新项置顶）、上限 `RECENT_CAP = 20`。
- `recent` **不存参数值**，只存 command 键 + 时间戳 → 重跑靠 `selectCommand` 重填默认值。
- 排序按 `createdAt` 升序；`order` = 插入时的序号（append 即 `max(order)+1`），P0 不用于排序，仅为 P1 拖拽预留。
- reconcile：拿当前 manifest 校验收藏项是否仍存在，产出 `stale`（派生、不持久化、不删除）。

## 4. 三层架构

```
[数据层] src/data/preferences.ts   —— 新增，纯函数，无副作用（storage 显式注入，可测）
   ↓ 被 store 调用
[状态层] src/store/appStore.ts     —— 扩展，新增 preferences 切片（state + actions）
   ↓ 被 UI 订阅
[UI 层]  src/features/nav/SiteCommandNav.tsx    —— 顶部加三个分组（最近/常用站点/常用命令）
         src/features/config/CommandConfig.tsx  —— 标题栏加 ☆站点 / ☆命令
         src/components/UndoToast.tsx            —— 新增，取消收藏的撤销提示
```

**边界说明（可独立理解/测试）：**
- `preferences.ts`：输入 `PreferencesSnapshot`（+ storage/命令），输出新的 `PreferencesSnapshot` 或布尔/集合。纯函数，不 import store、不 import React。
- store 切片：只做「读 prefs / 调纯函数产出新 prefs / setState + 落盘 / 派生 stale」，不含业务几何。
- UI：只订阅 `preferences` 与 `stale`，调 store action，不直接碰 localStorage。

## 5. 数据层签名（`src/data/preferences.ts`）

```ts
import type { CommandManifest } from './types'

export const PREFS_KEY = 'opencli-app:prefs:v1'
export const RECENT_CAP = 20

export function emptyPreferences(): PreferencesSnapshot
// 解析 localStorage；schemaVersion 不符 / JSON 坏 / 缺字段 → 回退 emptyPreferences（永不抛）
// 数组元素逐项校验（string 字段 + Number.isFinite 数值），坏项丢弃好项保留（复审 F3）
// 三数组统一 uniqueBy 唯一键归一化（首见保留；二轮复审 P2），recent 另截断 RECENT_CAP（M1）——载入端完整恢复 §3 数据不变量
export function loadPreferences(storage?: Storage): PreferencesSnapshot
export function savePreferences(prefs: PreferencesSnapshot, storage?: Storage): void  // storage 不可用则 no-op

export function isSiteFavorited(prefs: PreferencesSnapshot, site: string): boolean
export function isCommandFavorited(prefs: PreferencesSnapshot, command: string): boolean

// 幂等 toggle：存在→移除，不存在→追加（order = max+1, createdAt = now 由调用方传入以便可测）
export function toggleFavoriteSite(prefs: PreferencesSnapshot, site: string, now: number): PreferencesSnapshot
export function toggleFavoriteCommand(prefs: PreferencesSnapshot, command: string, site: string, now: number): PreferencesSnapshot

// 去重置顶 + 上限 RECENT_CAP
export function pushRecent(prefs: PreferencesSnapshot, command: string, at: number): PreferencesSnapshot

// 拿当前 manifest 校验，返回已失效（找不到对应命令/站点）的键集合，供 UI 灰显
export function staleKeys(prefs: PreferencesSnapshot, commands: CommandManifest[]): { sites: Set<string>; commands: Set<string> }

// 撤销回插：原记录原样回插（保 createdAt/order → 按 createdAt 排序自然回原位）；已存在则不动（幂等）（复审 F4）
export function restoreFavoriteSite(prefs: PreferencesSnapshot, item: FavoriteSite): PreferencesSnapshot
export function restoreFavoriteCommand(prefs: PreferencesSnapshot, item: FavoriteCommand): PreferencesSnapshot
```

**默认 storage：** 内部用 `storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)`；测试注入假 Storage（`Map` 包装），保证纯函数可测且不依赖浏览器。解析包在 try/catch 内——浏览器封锁存储时访问 `localStorage` 属性本身抛 SecurityError，降级为无存储（load 返 empty / save no-op），永不抛（复审 F2）。

**`now`/`at` 由调用方注入**（而非函数内 `Date.now()`）→ 纯函数、时间可控、单测稳定。

## 6. store 增量（`src/store/appStore.ts`）

新增 state：
```ts
preferences: PreferencesSnapshot     // 初始 = emptyPreferences()，挂载后 hydrate
stale: { sites: Set<string>; commands: Set<string> }   // 派生，不持久化
lastUndo?: { kind: 'site'; item: FavoriteSite } | { kind: 'command'; item: FavoriteCommand }   // 取消收藏时存完整被删记录（复审 F4）
```

新增 actions：
```ts
hydratePreferences: () => void        // = loadPreferences() → set；App 挂载时调一次
toggleSiteFavorite: (site: string) => void      // 调 toggleFavoriteSite → set → savePreferences
toggleCommandFavorite: (cmd: CommandManifest) => void  // 调 toggleFavoriteCommand(cmd.command, cmd.site)
undoLastFavorite: () => void          // 用 lastUndo 存的完整被删记录 restoreFavorite* 原位回插（复审 F4 升级，弃「再 toggle」）
dismissUndo: () => void               // 清 lastUndo
// 注：stale 派生不单列 reconcile action，内联进 setCommands / toggleSite/Command / hydratePreferences 的 set（单次原子，避免二次 set 读到旧 commands）
```

修改点（最小侵入）：
- `beginRun(runId)`：在现有逻辑末尾追加 `pushRecent(preferences, selected.command, Date.now())` → set → 落盘。**决策②**：最近记录发生在**运行开始**（beginRun），不是成功之后——运行过即算「最近用过」。
- `setCommands`：成功 setCommands 后内联 `staleKeys(preferences, commands)` 写入 `stale`（manifest 到齐才能算 stale；同一次 set 原子完成）。

**并发/顺序：** 内存先更新（set），再同步 `savePreferences`（localStorage 同步 API，P0 无需异步队列）。

## 7. UI 落点

### 7.1 `SiteCommandNav.tsx` — 顶部三分组（在「全部站点」之上）

在现有搜索框与 `<nav>` 分组列表之间插入三个可折叠分组，仅当 `q`（搜索词）为空时显示（搜索时只看全量结果，避免噪声）：

```
最近使用        recent.map → 查 commands.find(c=>c.command===r.command) → 命令按钮（点击=selectCommand）；查不到=灰显
常用站点        favoriteSites（按 createdAt 升序）→ 站点按钮（点击=进入精确站点过滤态 siteFilter，只显示 c.site===site 的命令组）；stale.sites 命中=灰显
常用命令        favoriteCommands → 命令按钮（点击=selectCommand）；stale.commands 命中=灰显
———— 全部站点（现有 groups 列表原样保留）
```

- 灰显：`opacity` 降低 + `title="该命令/站点在当前目录中已不存在"`，仍可点（命令仍在 recent/收藏里，只是当前 manifest 无匹配则禁用点击）。
- 命令按钮复用现有样式（第 32-40 行的 button 结构）。
- 站点过滤态：顶部显示可清除 chip（`站点：xxx ✕`）；输入搜索词即退出过滤；过滤态下隐藏三分组。**弃 setQ 借道全文搜索**——site 名作子串会跨站误命中（真实 catalog：`ke` 142 命中仅 6 条本站、`google` 39/4、`web` 35/1），不满足「进入站点目录」（复审 F1）。

### 7.2 `CommandConfig.tsx` — 标题栏两个收藏动作

在现有标题块（第 33-38 行 `selected.site / selected.name` + `<h2>` + 徽标）插入：
- 站点名后一个 ☆（收藏站点，hover 提示「收藏站点」，已收藏=实心 ★）。
- 命令名 `<h2>` 后一个 ☆（收藏命令，hover 提示「收藏命令」，已收藏=实心 ★）。
- 默认只显示描边星形以降噪；`isSiteFavorited(preferences, selected.site)` / `isCommandFavorited(preferences, selected.command)` 决定实心/描边。
- 点击 → `toggleSiteFavorite(selected.site)` / `toggleCommandFavorite(selected)`。

### 7.3 `UndoToast.tsx` — 撤销提示（新增，自建）

- 取消收藏（toggle off）时，store 记一个 `lastUndo`（被移除项 + 类型），UI 弹出「已取消收藏 · 撤销」约 5s。
- 点「撤销」→ `restoreFavorite*` 原记录原位回插（保原 createdAt/order；复审 F4 升级，弃「再 toggle」——那会刷新 createdAt 使项落列表末尾）。
- **自决**：不引第三方 toast 库，自建极简组件（一个绝对定位的浮层 + `setTimeout` 自动消失），零依赖。

## 8. 契约与安全边界

- **不改 HostBridge**：A 全程不触碰 `commandKey`/`argv`/`RunRequest`/SSE 契约，也不新增第二条 argv 构造路径（重跑走 `selectCommand` → 现有 `onRun` → 现有 `buildTokens`，不新造 token 化路径，规避 P0-B 硬前提 #2 的 buildTokens 预填不变式）。
- **无脱敏回放风险**：recent 不存 values；重跑靠 `defaultsOf(cmd)` 重填默认，不复现历史敏感值。
- **持久化只存偏好**：favoriteSites/favoriteCommands/recent 全是命令元数据（site/command 键 + 时间戳 + order），**不含任何参数值、凭证、token**。
- **失效不删**：reconcile 只派生 stale，不改持久化数据，避免临时下线导致收藏丢失。

## 9. YAGNI 边界（明确留 P1/后续块）

| 留后 | 归属 |
|---|---|
| 收藏命令的参数预设 `presetValues`（一键任务） | P1 |
| `Ctrl+K` 全局命令面板 | P1 |
| 带历史参数的精确重跑 | P1（受脱敏限制，需先解回放） |
| 拖拽排序（`order` 已预留） | P1 |
| 多任务中心 / 任务卡 | 块 C / P1 |
| 复制命令/结果/日志、错误详情展开、Catalog 真实刷新、键盘闭环 | 块 B/C |

## 10. 测试策略

- **数据层（Vitest 纯函数）** `preferences.test.ts`：
  - `loadPreferences` 坏 JSON / schemaVersion 不符 / 缺字段 → 回退 empty，不抛。
  - `toggleFavoriteSite/Command` 幂等（on→off→on 往返）、`order` 递增、`createdAt` 用注入 now。
  - `pushRecent` 去重置顶、超 20 截断、顺序（最近在前）。
  - `staleKeys` 命中/未命中、空 manifest。
  - round-trip：save → load 等值（注入假 Storage）。
- **store 切片**：hydrate 后 state 正确；toggle 触发 save（用假 Storage 断言落盘）；`beginRun` 追加 recent；`setCommands` 后 stale 正确派生。
- **UI（现有 RTL 模式）**：☆ 点击切换实心/描边；nav 三分组渲染 + 灰显 stale；重跑点击 = `selectCommand` 被调用且表单填默认值；UndoToast 出现与撤销回滚。
- **真实 catalog fuzz（验收门）**：用真实 `opencli list -f json`（1278 命令）随机抽样跑 toggle/recent/reconcile，断言无抛错、无键碰撞、stale 计算与 manifest 一致。

## 11. 验收标准（对应 RE §5，A 相关项）

- [ ] 「全部站点」之上依次出现 最近使用 / 常用站点 / 常用命令。
- [ ] 站点标题与命令标题各有独立收藏动作（☆站点 / ☆命令），实心/描边随收藏态。
- [ ] 收藏与最近记录在**刷新页面后保持**（localStorage 往返）。
- [ ] 点击常用站点 → 进入该站点命令目录（精确 `siteFilter` 过滤态，非全文搜索；chip 可清除）。
- [ ] 点击常用命令 / 最近项 → **载入其参数表单**（`selectCommand`，默认值填充）。
- [ ] manifest 更新后失效收藏**灰显保留**、不消失、不误删。
- [ ] 取消收藏出现短暂「撤销」提示，点撤销可恢复。
- [ ] 全程不改动 HostBridge 契约与 server；`npm test` 全绿、`npm run build` 通过。

## 12. 自决事项（已在对话中向用户标注，未被否决）

1. **UndoToast 自建**（不引第三方 toast 库）——零依赖、极简。
2. **最近记录发生在 `beginRun`**（运行开始即记），非成功之后——「运行过即最近用过」，也避免失败命令从最近列表消失导致无法重试。

## 13. 已知 backlog（非 A 范围，记录待块 C / 文档卫生处理）

- `HealthPill.tsx:10-18` 探活前默认「在线」→ 应 `checking/online/offline` 三态（**块 C**）。
- `server/run-manager.mjs:81-91` `seen` 集合无界增长 → active IDs + 有界 recent-ID 缓存（**块 C**）。
- `appendOutput` 全量 sort（O(n²)）（**块 C perf**）。
- master 设计 §3 把 BrowserBridge 验证写在 P0-B，与 P0-B 专项规格后置口径冲突 → 更新 master 设计消歧（**文档卫生**）。

## 14. 合并后复审修复（2026-07-24，分支 p0-c-a-fixes）

外部复审在已合并的块 A 上坐实 3 bug + 1 语义升级（均经独立核实），上文相关小节已同步为修复后语义：

| # | 问题 | 修复 |
|---|---|---|
| F1[P1] | 常用站点点击=setQ 借道全文搜索，真实 catalog 跨站噪声（`ke` 142 命中/6 本站、`google` 39/4、`web` 35/1；20/175 站点有噪声） | 独立 `siteFilter` 精确过滤态 + 可清除 chip，输入搜索即退出（§7.1） |
| F2[P2] | `resolveStorage` 在 try 外，浏览器封锁存储时访问 localStorage 属性本身抛 SecurityError → hydrate/收藏全断 | resolveStorage 内 try/catch 永不抛（§5） |
| F3[P2] | 持久化只验数组外壳，`[null]` 载入后 `isSiteFavorited` 抛 TypeError 可炸渲染 | 元素级校验，坏项丢弃好项保留（§5） |
| F4[🟡用户拍板] | undo=重新 toggle 刷新 createdAt，项落列表末尾 | `lastUndo` 存完整被删记录，`restoreFavorite*` 原位回插（§5/§6/§7.3） |
| 二轮P2 | 收藏数组载入未按唯一键去重（合法同键元素 2/2 载入 → 重复 React key / toggle 删全部重复 / undo 只恢复一项，违 §3 唯一键规则） | `uniqueBy` 首见保留统一归一化三数组（§5）；类型上须显式 `unknown[]` 注解（JSON.parse 的 any 使泛型推断失效） |

流程教训：块 A 的 whole-branch 评审点名过 F1/F3 但按「spec 措辞宽松/唯一写方」裁轻、未量真实数据幅度；F2 全漏。**裁「可接受」必须有真实数据量级，不能靠对 spec 措辞的解释。**
