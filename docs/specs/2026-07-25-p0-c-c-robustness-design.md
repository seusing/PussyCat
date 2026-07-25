# P0-C 块 C：健壮性·键盘·杂项清扫 设计

> 状态：v2（吸收外部设计复审 3 P1 + 2 P2 + 验收条件后修订），用户已预批「修订后可进 spec → plan → subagent-driven」。
> 基线：main @ 79d73a8（块 A/B 全收敛,200 测试）。
> 范围拍板：核心四件 + 积欠杂项全清；键盘 = RE/04:318 三键忠实（Ctrl/Cmd+K 聚焦搜索框——**非** P1 的全局命令面板）。

## 0. 设计复审裁决回执（v1 → v2）

| 复审项 | 吸收 |
|---|---|
| P1-1 Esc 应「关闭」不能 toggle | 优先级链成文（§1.3）：IME composing 忽略 → 焦点在可编辑元素则 blur → 面板展开则收起 → 已收起 no-op；`Esc` 只 `setCollapsed(true)` 永不 toggle |
| P1-2 Ctrl+Enter 不能直调裸 executeSelected | 复用 CommandConfig 的完整提交流程（`registerSubmit` 回调注册,§1.2）——非法表单仍显示字段错误+聚焦首错；`executeSelected` 补三守卫（catalog ready/无活跃 run/有 selected,§1.4）；Ctrl+K 用 App 持有的 ref 下传（§1.1,不查 data-testid DOM） |
| P1-3 appendOutput O(1) 声明不成立 | **已实测基准**（§4 表）：快路径=不可变追加、免 some/sort,8-13×@≤10k,50k 时 4.6×;渐近仍 O(n²) 复制,**只声称常数优化**;原地 push 破坏 Zustand 快照约定,否决;chunk 结构 YAGNI 留档（真实 run 事件量 <<10k,36kr/news 实测 25 事件） |
| P2-4 HealthPill 请求生命周期 | 超时+AbortController+世代 latest-wins+卸载/mode 切换取消+`role="status"` `aria-live="polite"`（§3） |
| P2-5 normalizeHostError 输入契约 | 结构化 `{summary,detail}` 透传,Error→message/stack,其余 String;context 只管 fallback 文案;start/cancel/结构化 rejection 三路测试（§6） |
| 验收条件（深度交互 5 条） | 逐条写入 §5.1（seen 判定与 cap<并发测试）/§5.2（resolver 每次解析不缓存失败+恢复测试）/§5.3（SSE 断线中间重连严格断言）/§7（Ctrl+K 消歧成文）/§1.3（Esc 只收起） |

## 1. 键盘层（RE/04:318 三键）

### 1.1 App 持有 refs 与热键注册
- App 创建 `searchInputRef = useRef<HTMLInputElement>(null)`，经 prop `searchRef` 传给 `SiteCommandNav` 绑到搜索 `<input ref>`。**不用 data-testid 查 DOM**。
- App `useEffect` 挂 `window.addEventListener('keydown', handler)`（卸载移除）。
- **Ctrl/Cmd+K**：`event.preventDefault()`（压掉浏览器默认）→ `searchInputRef.current?.focus()`。

### 1.2 Ctrl/Cmd+Enter = 完整 UI 提交流程
- App 持 `submitFormRef = useRef<(() => void) | null>(null)`；`CommandConfig` 新 prop `registerSubmit?: (fn: (() => void) | null) => void`，挂载时注册自己的 `handleRun`（含 validate → 显示字段错误 → 聚焦首错 → `onRun`），卸载注册 null。
- 热键调 `submitFormRef.current?.()` ——**非法表单与点运行按钮行为逐字一致**（错误可见+聚焦），不会「按了没反应」。

### 1.3 Esc = 关闭链（只关不开）
优先级链，命中即停：
1. `event.isComposing`（IME 输入中）→ 忽略。
2. `document.activeElement` 是 `input/textarea/select` 或 `contenteditable` → `blur()`。
3. 运行面板存在 run 且**展开** → `setRunPanelCollapsed(true)`。
4. 已收起/无 run → no-op。**永不 toggle、永不展开。**

### 1.4 executeSelected 三守卫收口（权威层）
键盘路径绕过按钮 disabled,权威守卫补齐,顺序:
```ts
if (s.catalogStatus !== 'ready') return false
if (s.currentRun && !isTerminal(s.currentRun.state)) return false   // 无活跃 run
if (!s.selected) return false
if (Object.keys(validate(s.selected, s.values)).length > 0) return false
```
（`isTerminal` 已有;运行按钮/重跑按钮行为不变,守卫只兜底。）

## 2. RunPanel 收起态提升 store

- store 新增 `runPanelCollapsed: boolean`（初始 false）+ `setRunPanelCollapsed(v: boolean)`；RunPanel 弃局部 `useState`,读写 store。
- `beginRun` 置 `runPanelCollapsed: false` = **新 run 自动展开**（清 P0-A 遗留）。
- ×收起语义不变：纯视图 flag,不碰 run 状态机（P0-A 铁律保持）。Esc 链第 3 步只写 true。

## 3. HealthPill 三态 + 请求生命周期

- 状态 `'checking' | 'online' | 'offline'`,初始 checking 显「检查中…」(`--color-fg-dim`)；首 ping 落定才变——消灭乐观默认的假「已连接」窗口。demo 模式不变。
- **请求生命周期**：每次 ping 持世代号 + `AbortController`（`setTimeout` 2s abort）;仅 `gen === latest` 的响应可提交状态（旧响应/超时响应不倒灌）;卸载与 mode 切换 abort 在途 + 清 interval。5s 轮询节奏不变。
- a11y：`role="status"` + `aria-live="polite"`。

## 4. appendOutput 常数优化（含基准证据）

**基准（本机 Node 25,单调 seq 流,累计耗时）：**

| N 事件 | 现实现(some+sort 每事件) | 快路径(不可变追加,免 some/sort) | 倍率 |
|---|---|---|---|
| 2,000 | 34ms | 4ms | 8.5× |
| 5,000 | 105ms | 12ms | 8.8× |
| 10,000 | 491ms | 36ms | 13.6× |
| 20,000 | 2,595ms | 1,337ms | 1.9× |
| 50,000 | 27,928ms | 6,024ms | 4.6× |

**裁决**：采「不可变追加快路径」——`e.seq > last.seq` 时 `[...lines, e]`（数组恒有序,尾后新 seq 不可能重复,免 `some` 免 `sort`）;乱序/重复走现有慢路径。**诚实口径：这是剔除 some/sort 的常数优化（实测 8-13×@真实量级）,渐近仍 O(n²) 复制;不可变/Zustand 快照约定保留;原地 push 否决;chunk 日志结构留档 P2**（真实 run 事件量 <<10k）。

## 5. server 杂项

### 5.1 run-manager `seen` 有界
- `maxSeenRunIds = 1000`（构造可注入）;`seen` 保持 Set（插入序）,超 cap 驱逐最旧。
- **重复判定必须 `this.active.has(runId) || this.seen.has(runId)`** ——在途 run 即使其 id 被 recent 集驱逐也**不可能**重复启动。
- 测试：cap 设为「小于最大并发数」(如 cap=1, maxConcurrentRuns=2),启动 2 个活跃 run（第 1 个 id 已被驱逐出 seen）→ 重复启动第 1 个 → 仍 409（靠 active.has 拦住）;驱逐语义测试（cap=2 塞 3 个,最旧 id 可重用,文档写明:重放保护有界,UUID runId 下碰撞理论级）。

### 5.2 manifest 惰性解析（块 B 终审 M3）
- `createCatalogService` 的 `manifestPath: string` 改为 `resolveManifest: () => string`（thunk;参数名与 opencli-entry 导出的 `resolveManifestPath` 函数区分,避免撞名——实现即此口径）;index.mjs 传 `resolveManifest: () => resolveManifestPath(opencliEntry)`,启动期**不再**急切求值——manifest 缺失只废刷新（500）,Host 照常启动。
- **每次 `refresh()` 都调用 resolver,失败不缓存**——文件事后出现即自动恢复。测试：resolver 先 throw（refresh 500,current() 不动）→ 改为返回有效路径 → 再 refresh 成功。

### 5.3 同步 spawn throw → 502
`spawnImpl(...)` 调用包 try/catch → `CatalogServiceError(502, 'Failed to spawn opencli list', msg)`。测试：spawnImpl 同步 throw → rejects 502。

### 5.4 SSE Last-Event-ID 补发单测（P0-B 遗留,HTTP 级）
测试剧本：跑一个多事件 run;第一条 `/events` 连接**在中间事件后断开**（记录已收到的最后 id）;带 `Last-Event-ID: <该 id>` 重连 → 严格断言:补发事件全部 `id > Last-Event-ID`、按 id 有序、与断前拼接后**无重无漏**（对照完整事件全集）。

## 6. normalizeHostError 输入契约 + context

```ts
function normalizeHostError(e: unknown, context: 'start' | 'cancel'): { summary: string; detail?: string } {
  const fallback = context === 'cancel' ? '取消请求失败' : '任务启动失败'
  if (e && typeof e === 'object' && !(e instanceof Error)) {
    const o = e as { summary?: unknown; detail?: unknown }
    if (typeof o.summary === 'string') {
      return { summary: o.summary, detail: typeof o.detail === 'string' ? o.detail : undefined }
    }
  }
  if (e instanceof Error) return { summary: e.message || fallback, detail: e.stack }
  return { summary: fallback, detail: String(e) }
}
```
结构化 `{summary,detail}` 透传不再退化 `"[object Object]"`;App 两处调用带 context。测试三路：start Error / cancel Error / 结构化 rejection。

### 6.1 `HostRequestError` 跨层错误契约（合并后复审 F2 补，**冻结面新增**）

**问题**：`nodeBridgeHost.responseError` 曾把服务端 `{summary, detail}` 拼进 `Error.message`，App 见 `Error` 就把整条当 summary、把 **JS stack** 当 detail —— 服务端 detail 常显、前端堆栈藏进 toggle，与块 B「summary 常显 / detail 按需」意图**反转**。根因是块 B 只做 App 层单测、无 NodeBridge→App 跨层集成测试，两侧各自自洽却整体错位。

**契约**（`src/host/errors.ts`）：

```ts
export class HostRequestError extends Error {
  readonly summary: string      // 常显：服务端摘要
  readonly detail?: string      // 按需：服务端详情；服务端未给时回填 `HTTP <status>`（保排障抓手）
  readonly status?: number
}
```

- **Host 实现（含未来 `tauriHost`）拒绝请求时必须抛 `HostRequestError`，不得把结构拼进 message。** `message` 仅为调试可读；消费方读 `summary`/`detail`。
- `normalizeHostError` 的 `HostRequestError` 分支必须排在 `instanceof Error` 分支**之前**（它继承 Error，放后面即死代码）。
- 全链锚点：`nodeBridgeHost.responseError` → `startCommand` reject → `App.executeSelected.catch` → `normalizeHostError` → `finishRun` → `RunPanel`（summary 无条件常显 / detail 在 `error-detail-toggle`）。**跨层集成测试是本契约的护栏**（`App.test.tsx` NodeBridge→App→`currentRun.error`）。
- done 事件路径（mockHost / 真实 run-manager）本就是 `{summary, detail}`，直接进 `finishRun`，不经此函数，无需同等处理。

## 7. 文档消歧（自做,不派 worker）

- master 设计 `2026-07-23-opencli-app-clone-p0-design.md` §3：BrowserBridge 验证从 P0-B 移出,口径对齐 P0-B 专项规格（后置到后续阶段）。
- 本 spec 成文：**块 C 的 `Ctrl/Cmd+K` = 聚焦现有搜索框;完整 command palette（收藏→最近→全部优先级弹层）仍是 P1**,两者不混。

## 8. 边界与测试

- 冻结 run 契约零触碰（键盘走 executeSelected 现有路径;seen/manifest/spawn 全在 run 契约之外;SSE 只加测试不改实现——若测试发现补发缺陷则按发现另裁）。
- 测试:键盘三键（KeyboardEvent 派发,含 IME composing 忽略/blur/收起链/已收起 no-op/非法表单 Ctrl+Enter 显示字段错误）;HealthPill（checking 初态/ok→online/fail→offline/慢响应倒灌被世代丢弃/卸载 abort）;appendOutput（行为等价:单调流/乱序/重复/终态抑制全保持）;seen（§5.1 两测）;manifest（§5.2 恢复测试）;spawn 502;SSE（§5.4 严格断言）;normalizeHostError 三路。
- 门:每 task `tsc → test → build` 全链 && 才 commit。

## 9. 验收标准

- [ ] Ctrl/Cmd+K 聚焦搜索框（ref 路径,非 DOM 查询）;Ctrl/Cmd+Enter 与点运行按钮行为逐字一致（含字段错误显示+聚焦首错）;Esc 关闭链四级且永不展开。
- [ ] executeSelected 三守卫(catalog ready/无活跃 run/有 selected)+校验,键盘绕不过。
- [ ] 新 run 自动展开运行面板;×收起语义不变。
- [ ] HealthPill 初态「检查中…」,首 ping 落定才变;旧/超时响应不倒灌;卸载/切模式取消在途;role=status。
- [ ] appendOutput 单调快路径,行为与现实现等价(既有全部用例仍绿),spec 口径=常数优化非 O(1)。
- [ ] seen 有界:active∪recent 判定;cap<并发 测试过;驱逐语义成文。
- [ ] manifest 惰性:Host 无 manifest 可启;失败不缓存,文件出现后 refresh 自愈。
- [ ] 同步 spawn throw → 502。
- [ ] SSE 断线中间重连:id>Last-Event-ID 严格、有序、无重无漏。
- [ ] normalizeHostError 结构化透传+双 context;master 设计 §3 消歧落地。
- [ ] 全程 `tsc`/`npm test`/`build` 绿;冻结契约零改动。
