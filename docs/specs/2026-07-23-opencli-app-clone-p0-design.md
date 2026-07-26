# OpenCLIApp 复刻 — P0 设计规格

- 状态：待评审（brainstorming 产出，用户确认方向后落档）
- 日期：2026-07-23
- 复刻对象：`opencli-app.exe`（Tauri 桌面壳 + OpenCLI 图形化前端）
- 逆向依据：`Documents/Codex/2026-07-22/xz/work/opencliapp-re/RE/01..06`
- 第二意见：`Desktop/正在进行的项目/opencli app.txt`（独立评审，已逐条核实并综合）

---

## 1. 背景与目标

`opencli-app.exe` 是一个 **Tauri** 桌面应用（Rust 宿主 + WebView 前端），本质是 OpenCLI（`@jackwener/opencli`）的图形化壳：管理 runtime、浏览器桥接、命令启动/取消、流式输出、设置与后台服务。

**复刻目标**：把"一个 CLI 自动化任务"变成一个可理解、可控制、可回看的小工作流——

```
选择能力 → 填参数 → 运行 → 看过程 → 拿结果 → 下次复用
```

这是一台 manifest 驱动的**任务控制台**，不是一组互相跳转的网页。

**本 spec 范围**：P0（前端最小闭环 → 尽早接真实 Node 执行 → 产品化补齐）。Tauri 桌面化整体后置到 P1。

---

## 2. 已核实的环境事实（2026-07-23，本机实测）

| 项 | 值 | 核实方式 |
|---|---|---|
| OpenCLI | `1.8.6` | `package.json` + `opencli --version` |
| Node | `v25.7.0` | `node -v`（注意：Node 25 会打印 `EnvHttpProxyAgent` 实验警告，无碍） |
| 包内 manifest | 1275 命令 / 173 站点，SHA-256 `310A143B41EA677DE88F05BFD9C525E3B1E19C14F88D0377356508B161ADF3E6` | `Get-FileHash` |
| `opencli list -f json` | **1278 命令 / 175 站点** | 亲测（输出带 UTF-8 BOM，解析前需 strip `﻿`） |
| 私有适配器 | `C:\Users\Lauseusing\.opencli\clis`：`baidubaike`、`hupu`、`news-cn` | 目录实测；list 独有站点为 `baidubaike`、`news-cn` |
| daemon 端口 | **19825**（逆向文档写的 19826 已漂移） | `opencli doctor -v` 全绿 |
| extension | `1.0.22`，profile `zyfcwzg6` connected，connectivity 0.1s | `opencli doctor -v` |

**字段差异（关键）**：
- `list` 独有：`command`（组合键 `site/name`）、`aliases`、`example`、`defaultFormat`
- `manifest` 独有：`type`、`modulePath`、`sourceFile`、`navigateBefore`、`defaultWindowMode`

结论：`list` 是**运行时归一化视图**且**覆盖私有适配器**，应作前端主数据源；但它**缺** `navigateBefore` / `defaultWindowMode`（规格 04 用于"执行前说明"），需用包内 manifest 按 `site+name` 补映射。

---

## 3. 范围与非目标

### P0-A：工程基线 + 最小纵向闭环
四道门槛：**独立仓库 · 运行时 catalog · 冻结 HostBridge · 一条可测试纵向切片**。

- catalog 快照（version/time/sha256）→ 加载、搜索、站点分组
- 选命令 → 动态参数表单（7 类字段规则）
- argv 构建 + 只读命令预览
- `deterministicMockHost` 流式输出
- 成功 / 失败 / 取消 三终态闭环，`runId` 贯穿
- 基础三栏界面

### P0-B：尽早验证真实执行（不等 UI 全完成）
轻量 Node Host：启动真实 `opencli`、流式 stdout/stderr、取消进程、超时、exitCode/错误归一化。
先跑通 **一条 PUBLIC 只读命令**。~~再验证一条依赖 BrowserBridge 的命令~~——**口径修正（块 C 消歧）**：BrowserBridge 验证已由 P0-B 专项规格（`2026-07-24-p0-b-node-host.md`）明确后置到后续阶段（含 COOKIE/INTERCEPT/UI 命令与 write/login 授权确认机制），P0-B 实际交付以专项规格为准（policy 白名单即排除 browser=true 命令）。

### P0-C：产品化补齐
两级收藏 + 持久化、最近使用、`columns` 表格/日志切换、重跑/复制命令/复制结果、catalog 刷新、错误详情与重试、基础键盘操作。

### P1：桌面化
**口径修正（2026-07-26，评审消歧）**：本节原本把五件事打包成一个"P1"，实际只拆做了第一件。**"P1 打包完成" ≠ "P1 完成"**，下面按已交付／未交付分开写，避免用一个名字覆盖两种范围。

**P1-A 　Tauri 打包（已交付，专项规格 `2026-07-25-p1-tauri-packaging-design.md`）**
Tauri 壳 + **SxS 14001 专项验证**（真机发布门）、内置固定版 OpenCLI production tree、Node Host 作为受管子进程（Job Object + stdin EOF 双清理通道）、readiness 协议与六类启动失败引导视图、MSI/NSIS 双安装包。

**P1-B 　桌面化其余部分（未做）**
`tauriHost` 替换 Node Host（本阶段**明确排除**：Host 仍是 Node 子进程，见专项规格 §2）、`Ctrl+K` 命令面板、托盘/设置/**自动更新**/安装检测、多任务并发与历史。

### 非目标（P0 明确不做，YAGNI）
真实站点图标、账户归档与全文搜索、认证刷新计划、web→markdown、Skills 管理中心、开机自启/保持唤醒、更新中心、多窗口。

---

## 4. 数据源与 catalog

**主源**：`opencli list -f json`（strip BOM）。
**补源**：包内 `cli-manifest.json`，按 `site+name` 补 `navigateBefore` / `defaultWindowMode` / `type` / `modulePath`。
**回退**：list 不可用时，用最近一次 catalog 快照 + 包内 manifest。

catalog 快照落地结构：

```json
{
  "schemaVersion": 1,
  "generatedAt": 1784800000000,
  "opencliVersion": "1.8.6",
  "source": "opencli list -f json",
  "listSha256": "…",
  "manifestSha256": "310A143B…ADF3E6",
  "commands": [ /* 归一化后的 CommandManifest[] */ ]
}
```

**归一化后的前端类型**（源自规格 04·§7，按 list 字段校正）：

```ts
type CommandManifest = {
  command: string          // "site/name"，list 主键
  site: string
  name: string
  description: string
  access: 'read' | 'write'
  strategy?: string
  browser: boolean
  args: ManifestArg[]
  columns?: string[]
  domain?: string
  aliases?: string[]
  example?: string
  defaultFormat?: string
  // 由包内 manifest 补映射：
  navigateBefore?: boolean | string
  defaultWindowMode?: 'foreground' | 'background' | string
  type?: string
  modulePath?: string
}

type ManifestArg = {
  name: string
  type: 'str' | 'string' | 'int' | 'number' | 'float' | 'bool' | 'boolean'
  required?: boolean
  help?: string
  default?: string | number | boolean
  choices?: Array<string | { label: string; value: string }>
  positional?: boolean
  valueRequired?: boolean
}
```

catalog 生成脚本 `scripts/sync-catalog.mjs`：调用 `opencli list -f json`、strip BOM、合并 manifest 补字段、算 sha256、写 `public/catalog.snapshot.json`。P0 手动/npm script 触发；P0-C 加"catalog 刷新"入口。

---

## 5. HostBridge 契约（冻结）

前端只依赖此接口，永不直接依赖 Tauri/Node。三种实现同接口：`deterministicMockHost`（P0-A）→ `nodeBridgeHost`（P0-B）→ `tauriHost`（P1）。

```ts
type RunRequest = {
  runId: string
  site: string
  command: string          // name
  args: Record<string, unknown>
  format?: 'table' | 'plain' | 'json' | 'yaml' | 'md' | 'csv'
}

type OutputEvent = {
  runId: string
  seq: number              // 单调递增，前端按 seq 排序/去重
  at: number
  stream: 'stdout' | 'stderr'
  text: string
}

type DoneEvent = {
  runId: string
  at: number
  outcome: 'success' | 'error' | 'cancelled'
  exitCode?: number
  result?: Record<string, unknown>[]     // 有 columns 时的结构化结果
  error?: { summary: string; detail?: string }
}

interface HostBridge {
  startCommand(req: RunRequest): Promise<{ runId: string }>
  cancelCommand(runId: string): Promise<void>
  onOutput(cb: (e: OutputEvent) => void): () => void
  onDone(cb: (e: DoneEvent) => void): () => void
}
```

**冻结的语义规则**（三实现都必须满足，用契约测试锁定）：
1. `done` 对每个 `runId` **恰好触发一次**；触发后不再有该 run 的 output。
2. `cancelCommand` **幂等**：对同一 runId 多次调用只产生一个最终 `done{outcome:'cancelled'}`。
3. **cancel ↔ 自然结束竞态**：若进程在 cancel 到达前已自然结束，采用真实终态（success/error），忽略 cancel。
4. 统一失败模型：启动失败、非零退出码、超时、被终止都收敛到 `done{outcome:'error'|'cancelled', exitCode?, error}`。
5. `seq` 单调递增；前端据此保证顺序与幂等追加。
6. **UI 收起（×）只改可见性，不改运行状态**；显式"取消执行"才终止。
7. 历史记录中的敏感参数**脱敏**（如 password/token/cookie 类字段值以 `••••` 存储与展示）。

---

## 6. 技术基座

- Vite + React 18 + TypeScript（strict）
- 样式：**Tailwind + CSS Variables**——设计 token（规格 05·§G）走 CSS Variables，布局/原子类走 Tailwind；暗色主题用 Variables 切换
- 状态：**Zustand**，slices 组织，P0 保持单一应用级 store（manifest / connection / runs / preferences 四切片）
- 测试：Vitest（单测 + 契约测试）；UI 冒烟走 Vite dev + 浏览器预览
- 目标浏览器：Chromium（与最终 WebView 一致）

---

## 7. 项目结构

```
opencli-app-clone/
├─ public/
│  └─ catalog.snapshot.json       # sync-catalog 产出的真实数据
├─ scripts/
│  └─ sync-catalog.mjs            # opencli list → 归一化 → 快照
├─ src/
│  ├─ main.tsx / App.tsx
│  ├─ host/
│  │  ├─ types.ts                 # HostBridge / RunRequest / *Event（§5）
│  │  ├─ mockHost.ts              # deterministicMockHost（P0-A）
│  │  ├─ nodeBridgeHost.ts        # P0-B
│  │  └─ index.ts                 # 运行时选择实现
│  ├─ data/
│  │  ├─ catalog.ts               # 加载快照、搜索、站点分组
│  │  └─ inputKind.ts             # 参数类型 → 控件（§9）
│  ├─ store/                      # zustand 四切片
│  ├─ features/
│  │  ├─ nav/                     # 左栏：搜索 / 站点分组 /（P0-C 收藏、最近）
│  │  ├─ config/                  # 中栏：命令头 + 动态表单 + 预览
│  │  └─ runs/                    # 右栏：任务卡 + 流式日志 + 结果表 + 取消
│  ├─ components/                 # 规格 05·§G3 组件清单
│  └─ styles/                     # tokens.css（CSS Variables）
├─ server/                        # P0-B：轻量 Node Host（spawn opencli + SSE）
└─ docs/specs/                    # 本 spec
```

---

## 8. UI 与状态机

### 三栏骨架（规格 04·§2 / 05·§C）
- 左：服务与命令发现（搜索、站点分组；P0-C 加收藏、最近）
- 中：命令头（站点·命令、read/write 标签、browser/会话标签）+ 动态表单 + 只读命令预览 + 高级信息
- 右：当前任务卡（状态条 + 耗时 + 取消入口）、流式日志、结果区（有 columns 时表格 ↔ 完整日志）

窄窗：右栏折叠为底部抽屉，左栏折叠为图标栏；主任务上下文始终留在一个窗口。

### 任务状态机（8 态，规格 04·§4）

```
idle → validating → starting → running → {succeeded | failed | cancelled} → idle
validating → idle（校验不过）
starting → failed（启动异常）
running → cancelling → cancelled（点取消，done/cancelled 收口）
```

| 状态 | 主按钮 | 右栏 |
|---|---|---|
| idle | 运行任务 | 空态 + 最近结果 |
| validating | 正在检查 | 不切走页面，高亮缺失字段 |
| starting | 正在启动… | 骨架日志，恒显"取消执行" |
| running | 运行中… | 逐行输出 + 自动滚动 + 耗时，恒显"取消执行" |
| cancelling | 正在取消…（锁定） | 保留已收到输出 |
| succeeded | 再次运行 | 结果表格 + 完整日志 |
| failed | 重试 | 错误摘要优先，日志可展开 |
| cancelled | 重新运行 | 取消时间点 + 已产生输出 |

命令弹层底部动作按状态切换：`运行前[复制][执行]` / `运行中[复制输出][取消执行]` / `取消中[复制输出][正在取消…]` / `结束[复制结果][再次执行]`。

---

## 9. 参数表单

类型归一化（规格 04·§3，覆盖实测 7 种 `int/boolean/str/string/bool/number/float`）：

```ts
type InputKind = 'text' | 'number' | 'switch' | 'select'
function inputKind(arg: ManifestArg): InputKind {
  if (arg.choices?.length) return 'select'
  if (['boolean', 'bool'].includes(arg.type)) return 'switch'
  if (['int', 'number', 'float'].includes(arg.type)) return 'number'
  return 'text'
}
```

规则：`required` → 必填标志 + 行内报错；`positional` → "位置参数"分组按序排列；`default` → 预填（不藏进 placeholder）；`choices` → Select（label/value 分离）。**仅在点击运行时**做校验，编辑中实时清除该字段错误，运行时聚焦第一个缺失字段。

---

## 10. 执行安全（P0-B）

- Node Host 用 `spawn(binary, argv, { shell: false })`，**绝不拼 shell 字符串**。
- 只读命令预览由 argv **单独转义**生成，仅供展示与复制，不参与实际执行。
- 端口/daemon **动态发现**（doctor/env），不固化 19825/19826。
- 超时可配置；超时/终止统一走 §5 失败模型。
- 敏感参数（password/token/cookie 类）在日志与历史中脱敏。

---

## 11. 测试策略

- **纯逻辑单测（Vitest）**：`inputKind` 映射、argv 构建、命令预览转义、catalog 归一化/补字段/分组、状态机迁移、（P0-C）收藏持久化。
- **HostBridge 契约测试**：对每个实现验证 §5 的 7 条语义（done-once、cancel 幂等、竞态、seq 单调、失败模型、脱敏）。mock 的三固定场景（成/败/取消）由测试显式选择，取消随机终态。
- **UI 冒烟**：Vite dev + 浏览器预览——真实 catalog 能渲染 1278 命令 / 175 站点导航；跑一条 mock 命令走完整状态机。
- **P0-B 真机验证**：一条 PUBLIC 只读命令真跑通过（已达成:36kr/news）。BrowserBridge 命令验证随其后置（见 §3 口径修正）。

---

## 12. P0-A 验收清单

- [ ] 独立仓 `Developer/opencli-app-clone` + Vite/React/TS/Tailwind/Zustand 基线可 `dev`/`build`/`test`
- [ ] `sync-catalog.mjs` 从 `opencli list -f json` 产出带 version/time/sha256 的快照，manifest 补 `navigateBefore`/`defaultWindowMode`
- [ ] 左栏读快照渲染 175 站点 / 1278 命令，支持搜索与站点分组
- [ ] 选命令生成动态表单，7 类字段规则 + 点运行才校验 + 聚焦首个缺失项
- [ ] argv 构建 + 只读命令预览（单独转义）
- [ ] `deterministicMockHost` 满足 §5 全部契约（契约测试绿）
- [ ] 三终态闭环，`runId` 贯穿；启动中/运行中恒有"取消执行"，× 只收起
- [ ] 基础三栏骨架 + 8 态状态机可视
- [ ] 顶部健康态显示"演示模式"（mock 阶段）
- [ ] 单测 + 契约测试全绿

---

## 13. 风险与决策记录

| 风险/决策 | 处置 | 置信度 |
|---|---|---|
| 本机新 exe 报 SxS 14001（2026-07-13 起，疑 Defender） | P0 全程浏览器/Node，不落 exe；P1 先做 Tauri hello-world 专项验证再决定 | 🟡 记忆实测教训 |
| daemon 端口漂移（19826→19825） | 动态发现，不固化 | 🟢 已核实 |
| `list` 缺 `navigateBefore`/`defaultWindowMode` | manifest 按 `site+name` 补映射 | 🟢 已核实 |
| 私有适配器不在包内 manifest | 主源用 `list`（含私有适配器）；用户自己就装了 3 个 | 🟢 已核实 |
| Node 25 实验警告 | 无碍，spawn/child_process 稳定 | 🟢 |
| manifest 会随 OpenCLI 升级漂移（1257→1275→1278） | 一切动态生成，绝不硬编码命令页面 | 🟢 已核实 |

---

## 14. 溯源

- 产品设计：`RE/04-command-workspace-spec.md`、`RE/05-full-product-design-spec.md`、`RE/06-favorites-cancel-and-feature-roadmap.md`
- 逆向基础：`RE/01-ida-mcp-initial-map.md`（框架/关键函数）、`RE/02-command-execution-chain.md`（执行链）、`RE/03-ui-and-interaction-map.md`（窗口/交互）
- 宿主契约来源：`opencli_command_start/cancel` + `opencli-command://output|done`（RE/01-03 逆向确认）
- 第二意见评审：`Desktop/正在进行的项目/opencli app.txt`（数据源以 list 为准、最小闭环先行、尽早真接、仓库外置、HostBridge 语义补齐、spawn 安全——均已核实采纳）
