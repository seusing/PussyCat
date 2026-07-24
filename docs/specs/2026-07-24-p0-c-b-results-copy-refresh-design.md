# P0-C 块 B：结果·错误·复制·重跑·Catalog 真刷新 设计

> 状态：v2（吸收外部设计复审 4 阻塞 + 3 补全后修订），待用户审后转 writing-plans。
> 基线：main @ 612ab26（块 A + 两轮复审修复全收敛，142 测试）。
> 关联：RE/06 §1.3 按钮状态机、§3.4 结果格式；用户 P0-C 验收矩阵（复制/重跑/错误详情/Catalog 刷新四个 ❌/🟡 项）。

## 0. 设计复审裁决回执（v1 → v2 变更）

| 复审项 | 吸收方式 |
|---|---|
| 阻塞1 传输所有者 | 新增 `CatalogSource` 抽象，由 `createHostSelection` 与 Host 共用 baseUrl（§3.1），App 不读 env |
| 阻塞2 policy 漂移 | 服务端 `CatalogService`：spawn+merge+schema 校验+新 policy 构建全成功后**原子替换** snapshot+policy，`/start` 改读动态 policy 引用（§4） |
| 阻塞3 selected/values 陈旧 | `setCommands` 扩展三分支语义：同 key 换新 manifest+活值合并 / key 删清空 / `currentRun` 永不改写（§5） |
| 阻塞4 校验权威 | 新增 `executeSelected()` 权威守卫（内部再验），CommandConfig 与 rerun 都走它；disabled 仅 UI 提示（§3.3） |
| 补全5 复制语义 | 文案「复制结构化结果」+ `JSON.stringify(run.result ?? [], null, 2)`；失败且 `lines=[]` 回退 `error.detail ?? error.summary`；lines 按 seq 升序 join（§3.4） |
| 补全6 资源边界 | 8 MiB 上限/状态码矩阵/close 杀在途子进程/spawnImpl·readFile·clock 注入/manifest 路径从 opencliEntry 反推/Node≥23 约束声明（§4.2） |
| 补全7 AppShell 范围 | `AppShell` 加通用 `headerActions` 槽；refresh 态独立于 `catalogStatus`；复制反馈/clipboard 降级次序/`cache:'no-store'`（§3.5） |

**两项最终拍板（用户复审推荐，已采纳）**：
① 动态刷新**同步原子更新服务端执行 policy**（校验后原子换，否则只是"浏览目录刷新"）。
② 成功态复制**结构化 `run.result`**（不为复制 raw stdout 扩大运行契约）。

## 1. 范围

- 语境化复制三态：运行前复制命令 / 成功复制结构化结果 / 失败·取消复制日志。
- 重跑：succeeded=再次执行 / failed=重试 / cancelled=重新执行。
- 错误详情：`error.detail` 可展开。
- Catalog 真刷新：connected 模式服务端现场重生成（含 policy 原子更新）；demo 模式重拉 snapshot。
- **不在 B**（块 C / P1）：键盘闭环、HealthPill 三态、`seen` 生命周期、appendOutput O(n²)、TSV/表格导出、复制单元格、历史参数回放、任务历史列表、目录定时自动刷新。

## 2. 已定决策表

| # | 决策 | 结论 |
|---|---|---|
| ① | Catalog 刷新深度 | Node Host 真刷新（`GET /catalog` 现场 spawn `opencli list`）+ **policy 校验后原子更新**；demo 降级重拉 snapshot |
| ② | 复制口径 | 语境化三态（RE/06 状态机）；成功态=结构化 `run.result` JSON |
| ③ | 重跑语义（自决沿块 A①） | 重新提交**活表单**（`selected+values` 未脱敏）；仅 `selected.command === currentRun.command.command` 时显示；权威守卫 `executeSelected()` 再验 |
| ④ | 刷新失败降级（自决） | **不打翻现有目录**：不走 `setCatalogStatus('error')`（错误屏只属首载失败），按钮旁提示，目录保持 ready |
| ⑤ | generatedAt（自决） | App 局部 state 传 prop，不动 store |
| ⑥ | connected 首载（自决，标注待否） | `load()` 先试 live `/catalog`，失败自动降级 snapshot（console.warn）——Host 未起时目录仍可离线浏览，与现状对齐；刷新按钮重试 live |

## 3. 前端架构

### 3.1 CatalogSource（阻塞1）

`src/host/index.ts` 扩展（**不碰 `HostBridge` 接口本身**）：

```ts
export type CatalogLoadResult = { snapshot: CatalogSnapshot; degraded?: string }  // degraded=live 失败降级 snapshot 的原因
export type CatalogSource = {
  load(): Promise<CatalogLoadResult>   // 首载与手动刷新共用
  kind: 'snapshot' | 'live'
}
export type HostSelection = {
  host: HostBridge
  catalogSource: CatalogSource
  mode: 'demo' | 'connected'
}
```

> `degraded` 的必要性：决策⑥的静默降级若不带标记，connected 模式手动刷新在 Host 挂掉时会**伪装成刷新成功**（返回的是本地快照），与补全7「失败可见提示」矛盾。载入侧：首载与手动刷新的 degraded **统一在按钮旁显示「已降级：本地快照」**（+console.warn）——connected 模式 Host 启动即不可达时，用户第一时间知道自己看的是陈旧本地数据（终审 M1 裁定为 UX 增益，实现即此口径；demo 模式永不 degraded）。两路都失败才走 catch（刷新失败提示 / 首载错误屏）。

- demo：`snapshotCatalogSource()` — `fetch('/catalog.snapshot.json', { cache: 'no-store' })` + 现有 `assertSnapshot` 校验（复用 `loadCatalog` 逻辑，`cache` 参数化）。
- connected：`liveCatalogSource(baseUrl)` — `fetch(`${baseUrl}/catalog`)`（同一 baseUrl 由 `createHostSelection` 解析一次，与 `createNodeBridgeHost` 共享；默认 `http://127.0.0.1:43117`）→ `assertSnapshot`；**失败降级** snapshot 源并 `console.warn`（决策⑥）。
- App 经 props 收 `catalogSource`（`App({ host, catalogSource, mode })`），`fetchCatalog`/刷新统一 `catalogSource.load()`；测试注入 fake source。

### 3.2 重跑 + 权威守卫（阻塞4）

`App.tsx`：

```ts
const executeSelected = (): boolean => {
  const s = useAppStore.getState()
  if (!s.selected) return false
  if (Object.keys(validate(s.selected, s.values)).length > 0) return false   // 权威再验
  const runId = crypto.randomUUID()
  s.beginRun(runId)
  const argv = buildArgv(s.selected, s.values)
  void host.startCommand({ runId, commandKey: s.selected.command, argv })
    .catch((err) => useAppStore.getState().finishRun({ runId, at: Date.now(), outcome: 'error', error: normalizeHostError(err) }))
  return true
}
```

- `CommandConfig` 的 `onRun` prop = `executeSelected`；其 `handleRun` 仍先本地 `validate` 展示字段错误+聚焦（UX 层），再调 `onRun`（权威层，双验幂等）。
- `RunPanel` 新 prop `onRerun` = `executeSelected`；重跑按钮**显示条件** `selected?.command === run.command.command` 且 run 处终态；**disabled** = `validate(selected, values)` 有错（UI 提示，title「参数校验未通过，请回表单修正」）；权威守卫兜底（disabled 被绕过也不会起跑）。
- 按钮文案：succeeded「再次执行」/ failed「重试」/ cancelled「重新执行」（RE/06）。

### 3.3 语境化复制（补全5）

新 `src/data/copyPayload.ts`（纯函数，可测）：

```ts
export type CopyPayload = { label: string; text: string }
export function copyPayloadFor(run: CommandRun): CopyPayload | null {
  if (run.state === 'succeeded') {
    return { label: '复制结构化结果', text: JSON.stringify(run.result ?? [], null, 2) }
  }
  if (run.state === 'failed' || run.state === 'cancelled') {
    const log = [...run.lines].sort((a, b) => a.seq - b.seq).map((l) => l.text).join('\n')
    const fallback = run.error ? [run.error.summary, run.error.detail].filter(Boolean).join('\n') : ''
    return { label: '复制日志', text: log || fallback }   // 启动失败 lines=[] 回退 error
  }
  return null   // active / 无终态不提供复制
}
```

新 `src/lib/clipboard.ts`：

```ts
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
  } catch { /* writeText reject → 落 fallback */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch { return false }
}
```

降级次序：`navigator.clipboard.writeText` **缺失或 reject** 后才走 textarea fallback；两者皆败返 false。fallback 的 textarea 清理必须 `try/finally`——`select()`/`execCommand()` 抛错时含完整命令/日志的隐藏节点不得驻留 DOM（三轮复审 F3，回归断言 `querySelectorAll('textarea')` 为空）。

- 运行前复制命令：`CommandConfig` preview 旁「复制命令」按钮，text = 当前 preview 同一字符串（`commandPreview(selected, values)` 现有产物）。
- 复制反馈：点击后按钮文案短暂（~1.5s）变「已复制」/「复制失败」后回弹（组件局部 state + setTimeout）。

### 3.4 错误详情展开

`RunPanel` 错误条：summary 常显；`run.error.detail` 存在时加「详情 ▾/▴」toggle，展开 `<pre className="overflow-auto">{detail}</pre>`（`data-testid="error-detail"`）。

### 3.5 AppShell 与刷新 UI（补全7）

- `AppShell` 加通用槽 `headerActions?: ReactNode`，header 右侧渲染 `{headerActions}<HealthPill />`——**不塞 Catalog 业务逻辑进 AppShell**。
- App 组装刷新控件（App 内小组件）：
  - 局部 state：`refresh: { state: 'idle' | 'refreshing' | 'error'; error?: string; generatedAt?: number }`——**独立于首载 `catalogStatus`**，不复用 loading/error 覆盖三栏（决策④）。
  - **latest-wins 契约（三轮复审 F1 补）**：刷新按钮在首载期间即可用，故首载与手动刷新共享同一请求世代计数 `loadGen`（useRef）；每次发起 load 递增世代，then/catch 提交前校验世代，**过期响应（无论成功/失败/降级）一律丢弃**——只有最新请求有权更新 commands/generatedAt/degraded/error。受控 Promise 回归测试锁定「慢首载不得覆盖已成功的手动刷新」。
  - 按钮「刷新目录」：在途 disabled + 「刷新中…」；成功 → `setCommands(snap.commands)`（自动触发 §5 的 selection reconcile 与 stale 重算）+ 更新 `generatedAt`；失败 → 按钮旁小字「刷新失败」（title=详情），**目录保持 ready**。
  - 旁显「N 条 · HH:mm 更新」（N=commands.length，时间取 snapshot.generatedAt）。

## 4. 服务端 CatalogService（阻塞2 + 补全6）

### 4.1 原子刷新语义

新 `server/catalog-service.mjs`：

```
createCatalogService({ opencliEntry, manifestPath, spawnImpl?, readFileImpl?, clock?, timeoutMs=15000, maxOutputBytes=8*1024*1024 })
  → { refresh(): Promise<snapshot>, current(): snapshot|undefined, close(): void }
```

`refresh()` 流水（**全部成功才替换，任一失败旧值不动**）：
1. single-flight：在途 refresh 复用同一 promise。
2. `spawnImpl(process.execPath, [opencliEntry, 'list', '-f', 'json'], { shell: false, windowsHide: true })`（P0-B 同款安全姿势，绕 cmd.exe）。
3. 收集 stdout ≤ `maxOutputBytes`（超限 kill 子进程 → 失败）；`timeoutMs` 超时 kill → 失败；非零退出 → 失败。
4. `JSON.parse(stripBom(stdout))` 坏 JSON → 失败。
5. `mergeManifestFields(list, manifest)`（`readFileImpl(manifestPath)`；`.mjs → src/data/normalize.ts` import 已由 `scripts/sync-catalog.mjs` 在本机 Node 25 实证可用——**运行约束：Node ≥ 23（type-stripping）**，写入 server README/注释）。
6. schema 深校验（三轮复审 F2 升级为**双端共享** `src/data/catalogSchema.ts` 的 `assertCatalogCommands`）：`schemaVersion:1`、commands 非空数组、每条 command/site/name/access/args 齐 + **元素级** args（name/type string）与 choices（string 或 {label,value}）+ **key 一致性**（command===site/name）+ **重复 command 拒绝**。fail-loud（与块 A preferences「坏项丢弃」区分：catalog 是单一生成器产物，结构异常=生成端 bug；服务端原子替换保旧值，前端首载走错误屏/刷新走失败提示）。四规则已在真实 catalog 1278 命令上预验零异常。
7. `buildExecutionPolicy(snapshot)`（见 §4.3）构建新 policy。
8. **原子替换**：`state = { snapshot, policy }` 单引用一次性换。
9. 返回新 snapshot。

- `manifestPath`：由 `opencliEntry`（`…/@jackwener/opencli/dist/src/main.js`）**反推包根** `join(entry, '../../..', 'cli-manifest.json')`——不硬编码全局 npm 路径；`server/opencli-entry.mjs` 新增 `resolveManifestPath(entry)` 并校验存在。
- `close()`：kill 在途 catalog 子进程；挂到 host `app.close()` 关停链。

### 4.2 `GET /catalog` 状态码矩阵

| 情形 | 状态码 | body |
|---|---|---|
| 刷新成功（替换完成后） | 200 | 新 snapshot JSON |
| spawn 失败 / 非零退出 | 502 | `{ error: { summary, detail } }` |
| 超时 / 输出超 8 MiB | 504 / 502 | 同上（超时 504，超限 502） |
| 坏 JSON / schema 校验失败 / policy 构建失败 | 500 | 同上 |

（`GET /catalog` 只在替换完成后返回新 snapshot——**返回的目录与生效的 policy 恒一致**。）

### 4.3 policy 动态化（阻塞2 核心）

- `server/policy.mjs` 抽纯函数 `buildExecutionPolicy(snapshot)`（现 `loadExecutionPolicy` 的过滤逻辑：`access==='read' && strategy==='public' && browser===false` → allowedCommands Set）；`loadExecutionPolicy(path)` 改为 读盘+`buildExecutionPolicy` 薄包装（磁盘首载不变）。
- `host-server.mjs`：`policy` 参数改为 **`getPolicy(): policy` 访问器**（或 `policyRef`）；`/start` 校验时实时取。`index.mjs`：初始 policy 仍从磁盘 snapshot 构建；创建 CatalogService 并把「刷新成功 → 换 policyRef」接上；`GET /catalog` 路由接 `service.refresh()`。
- **安全不变量**：过滤准则是代码不是数据——刷新只改命令集合，白名单准则（read+public+browser=false）、commandKey==argv 校验、强制 `-f json`、回环 bind、CORS 全不动。

## 5. store：`setCommands` 三分支（阻塞3）

```
setCommands(commands) 在现有(换 commands/catalog 态/stale 派生)之上扩展：
  A. selected 且新目录含同 key → selected = 新 manifest；
     values = { ...defaultsOf(新), ...仅保留(旧 values 中键 ∈ 新 args 名单的活值) }
     （仍存在参数保活值，新参数补 default，消失参数丢弃）
  B. selected 且同 key 已删 → selected = undefined, values = {}
  C. currentRun 永不改写（历史运行快照，其 command/values/lines/result 保持运行时刻的 manifest）
```

实现为 store 内纯 helper `reconcileSelection(selected, values, commands)`，store 测试覆盖 A/B/C 三分支 + 参数定义变化（旧值保留/新默认补齐/删除参数丢弃）。

## 6. 契约与安全边界

- **HostBridge 冻结契约零触碰**：`startCommand/cancelCommand/onOutput/onDone`、`/start /cancel /events` 语义与 SSE 事件形状全不动；`CatalogSource` 是并列新抽象；`GET /catalog` 是新增只读端点。
- **无新 argv 构造路径**：重跑走 `executeSelected` → 现有 `buildArgv`（P0-B 硬前提 #2 安全）。
- **复制不碰脱敏**：复制命令取 preview（值来自活表单，用户所见即所得）；结构化结果/日志来自 run 事件流，本就不含表单敏感值（`currentRun.values` 已脱敏且不参与复制）。
- **刷新安全**：spawn 参数全为服务端常量（entry + 'list' + '-f' + 'json'），无任何请求输入参与；资源边界见 §4.2。

## 7. 测试策略

- `copyPayload`：三态 label/text、失败空 lines 回退 error、seq 乱序 join 排序、active 返 null。
- `clipboard`：writeText 成功 / 缺失走 fallback / reject 走 fallback / 全败 false（jsdom stub）。
- `RunPanel`：终态按钮矩阵（复制+重跑文案三态）、重跑显示门（selected 换命令即隐）、disabled（validate 错）、详情展开、复制点击断言 copyText 收到正确 text、反馈文案回弹。
- `CommandConfig`：复制命令按钮 text=preview。
- store：`setCommands` A/B/C 三分支 + 参数演化矩阵。
- `host/index`：`createHostSelection` 返回 catalogSource（demo/live 两模式）、live 失败降级 snapshot。
- server：`catalog-service` 注入 spawnImpl/readFileImpl/clock 测 成功替换/超时 kill/超限 kill/非零退出/坏 JSON/schema 败/single-flight/close 杀进程/失败旧值不动；`policy` buildExecutionPolicy 纯函数测；`host-server` GET /catalog 路由 200/502/504/500 + `/start` 用刷新后 policy 放行新命令、拒绝已删命令（**漂移回归测试**）。
- App：刷新成功换目录+selection reconcile 生效；刷新失败目录保持 ready + 按钮旁提示（不出错误屏）。
- 门（每 task）：`tsc --noEmit` → `npm test` → `npm run build` 全链 && 才 commit（84bc161 事故铁律）。

## 8. 验收标准

- [ ] 运行前可复制命令（与 preview 一致）；成功可复制结构化结果（result JSON）；失败/取消可复制日志（含启动失败回退 error）。
- [ ] 终态重跑按钮三文案正确；切走命令即隐藏；校验不过 disabled 且权威守卫拦截。
- [ ] `error.detail` 可展开/收起。
- [ ] connected 模式点「刷新目录」→ 服务端现场重生成并**同步原子更新 policy**——刷新后新增命令可直接运行、已删命令被 403（漂移闭环）。
- [ ] demo 模式刷新 = 重拉 snapshot（no-store）。
- [ ] 刷新失败不打翻现有目录（无错误屏），按钮旁可见提示。
- [ ] 刷新后：selected 同 key 换新 manifest 且活值保留/新参补默认；key 删则清空表单；currentRun 不变。
- [ ] 冻结 run 契约零改动；`tsc`/`npm test`/`build` 全绿。

## 9. 合并后三轮复审修复（2026-07-24，分支 p0-c-b-fixes）

外部复审在已合并的块 B 上坐实 1P1+2P2（均经独立核实），上文相关小节已同步为修复后语义：

| # | 问题 | 修复 |
|---|---|---|
| F1[P1] | 首载与手动刷新独立提交、无排序契约——慢首载降级响应覆盖已成功的手动刷新（确定性复现）；根因=两轮评审都盯服务端 single-flight，没人认领**前端**响应排序 | 请求世代 `loadGen` latest-wins（§3.5），受控 Promise 确定性回归 |
| F2[P2] | 双端只查 args 是数组不验元素，`args:[null]` 进 policy、DynamicField 访问 arg.choices 炸 UI | 共享 `catalogSchema.ts` 深校验双端接线（§4.1），真实 catalog 1278 门测试；collateral=空 catalog 拒绝在前端新生效（正确收敛：空目录=生成端坏，错误屏比「ready 空列表」诚实） |
| F3[P2] | clipboard fallback 抛错时含复制内容的 textarea 永久驻留 DOM | 内层 `try/finally` 清理 + DOM 断言回归（§3.3） |

流程教训：**「刷新按钮在首载期间可用」是可用性选择，但没配排序契约背书**——并发面的裁决不能只看服务端；前端每个可并发提交结果的入口都要有明确的 latest-wins/取消契约。
