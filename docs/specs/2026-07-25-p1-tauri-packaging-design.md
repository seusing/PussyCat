# P1 Tauri 打包（方案 A：Tauri 壳 + 受管 Node Host 子进程）设计

> 状态：v2（吸收设计复审 4 P1 + 2 P2 + 术语/措辞收紧），待用户审后转 writing-plans。
> 基线：main @ 199fb19（P0-C 三块 + 两轮合并后复审 + P3 backlog 全清，237 测试）。
> 前置 spike（已做）：本机 Rust 1.97.1 就绪；**裸 Tauri v2 GUI exe 在非豁免路径启动通过**（usage-island app.exe 9.4MB，进程存活 32MB RSS，无 SxS 报错）。

## 0. 决策与复审回执

**用户已拍板**：
| # | 决策 | 结论 |
|---|---|---|
| ① | 架构 | **方案 A**：Tauri 壳 + **受管 Node Host 子进程**，复用 P0-B 全部安全资产与 `nodeBridgeHost`，零新执行契约 |
| ② | OpenCLI 供应 | **内置固定版 production tree**（`@jackwener/opencli@1.8.6` + prod 依赖，实测 ~30MB）；不做跨 npm/nvm 的全局发现协议 |
| ③ | Node 门槛 | **消除运行时 `.ts` import → 降到 `>=20`**，与 opencli 自身 `engines` 持平（能跑 opencli 的机器就能跑 Host） |

**设计复审吸收（全部经我独立核实）**：
| 复审项 | 吸收 |
|---|---|
| P1-1 资源闭包不成立 | 核实更宽：`catalog-service.mjs` 运行时 import **两个** `.ts`。→ §3 自包含 runtime 生成 + §9 T0 隔离闭包 spike（先验证再开工） |
| P1-2 全局 opencli 找不到 | 核实：`createRequire(import.meta.url)` 从资源目录解析。→ 决策② 内置；Node 探测改为 **版本探测 `>=20`** 而非「能执行即可」 |
| P1-3 前端双事实源 | 核实：`HealthPill` 独立读构建期变量并回落 43117 → 随机端口下必显离线。→ §6 `HostSelection` 唯一 `baseUrl` 沿 main→App→AppShell→HealthPill 注入，五端点同端口断言 |
| P1-4 启动协议未闭合 | 核实：`index.mjs` 只认 `OPENCLI_HOST_PORT`、stdout 是人读文案。→ §4 机器可读 readiness JSON + 四类失败分支 + **持续排空 stdout/stderr**（防管道背压死锁） |
| P2-5 进程清理未决 | → §5 **Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 为主路径**，spawn 后立即 assign；`taskkill /T` 仅异常兜底；single-instance **必须在 Host bootstrap 之前**生效 |
| P2-6 CSP/Origin | → §7 随机端口进 `connect-src`；生产 WebView 真实 `Origin` **由安装包实测捕获**后精确加白，禁止「猜测+同时放宽多个」 |

**措辞收紧（照复审）**：
- SxS：**裸 Tauri GUI exe 在当前机器非豁免路径通过，风险显著下降**；MSI/NSIS 启动器与安装后 exe **仍是发布门**，未通过前不得宣称"解除"。
- 术语：Node Host 是 **受管子进程（managed child process）**，**不是** Tauri `externalBin` 意义的 sidecar——文档与配置命名一律区分，避免误配 bundler。

## 1. 范围

**做**：自包含 Host runtime 生成 → readiness 协议 → Rust supervisor（Job Object/单实例/窗口时机）→ 前端唯一 baseUrl → CSP/CORS/资源配置 → MSI+NSIS 真机闭环。

**不做（留后续）**：真 `tauriHost`（Rust 侧执行，见决策①代价分析）；自动更新；代码签名；macOS/Linux 目标；opencli 版本热升级。

## 2. 架构与进程模型

```
Tauri 主进程 (Rust)
├─ single-instance 插件（最先，早于 bootstrap）
├─ Job Object（KILL_ON_JOB_CLOSE）
│   └─ 受管子进程：<系统 node> resources/host/server/index.mjs   [OPENCLI_HOST_PORT=0]
│        └─ 运行时按需 spawn：<系统 node> resources/host/node_modules/@jackwener/opencli/dist/src/main.js
├─ 读 readiness JSON（超时/错误分支 → 错误视图）
└─ WebviewWindowBuilder 建窗（注入 boot 配置）→ 前端走 nodeBridgeHost 连 127.0.0.1:<随机端口>
```

- **Node 外置**：目标机需 `node >= 20`（安装 opencli 的前提本就如此）；启动时**探测版本**，不达标 → 引导视图（写明所需版本与当前版本）。
- **OpenCLI 内置**：资源目录自带 production tree，`createRequire` 天然解析到它——与决策②一致，无发现协议。

## 3. 自包含 Host runtime（解 P1-1）

新增 `scripts/build-host-runtime.mjs`，产出 `dist-host/`（Tauri `resources` 打包它）：

```
dist-host/
├─ server/*.mjs                     # 原样拷贝
├─ shared/*.mjs + *.d.mts           # 见下「消除 .ts import」
├─ public/catalog.snapshot.json     # 首载 policy 来源
└─ node_modules/@jackwener/opencli@1.8.6 + prod 依赖
```

生成方式：`npm install @jackwener/opencli@1.8.6 --omit=dev --prefix dist-host`（锁定版本，产出 production tree）+ 文件拷贝。**闭包由 T0 spike 在隔离目录实证**（§9），不靠推断。

**消除运行时 `.ts` import（决策③）**：
- `src/data/normalize.ts` / `src/data/catalogSchema.ts` 改为 **`.mjs` + 手写 `.d.mts`**（纯函数，无框架依赖），移到 `src/shared/`（前端与 server 共用同一份，单一事实源）。
- 消费点全改：`src/data/catalog.ts`、`server/catalog-service.mjs`、`scripts/sync-catalog.mjs`、各测试。
- 连带**拆掉** `server/index.mjs` 的「先断言 Node>=23 再动态 import」那套 guard —— 它当初正是为 type-stripping 而立；改为 **`>=20` 版本断言**（静态 import 即可，无 `.ts` 依赖后不再有「断言前解析依赖图」的陷阱）。

## 4. 启动协议（解 P1-4）

**Host 侧**（`server/index.mjs`）：
- 端口：沿用 **`OPENCLI_HOST_PORT=0`**（不引入 `--port`，避免两套入口）；listen 后取实际端口。
- **成功**：向 stdout 打印**恰一行**机器可读 JSON，随后照常人读日志：
  ```json
  {"opencliHostReady":true,"port":54321,"pid":1234,"opencliVersion":"1.8.6","policyCommands":277}
  ```
- **失败**（catalog 缺失/opencli 解析失败/listen 失败等）：打印一行
  ```json
  {"opencliHostReady":false,"error":{"summary":"...","detail":"..."}}
  ```
  并以非零码退出。

**Rust 侧**读取契约：
- 逐行读 stdout，**首个含 `opencliHostReady` 的 JSON 行**即判定；
- **持续排空 stdout/stderr 直到进程退出**（不得读到首行就停 —— 管道满会背压死锁子进程）；排空内容转 Tauri 日志。
- 四类失败分支各自映射错误视图：① spawn 失败（node 不存在/不可执行）② 版本不达标（探测 `node --version` < 20）③ readiness 超时（默认 15s）④ 子进程提前退出或输出非法 JSON。

## 5. Rust supervisor（解 P2-5）

- **single-instance 插件最先注册**，早于任何 Host bootstrap —— 否则第二实例会先拉起第二个 Node 再被劝退。参考同机 `usage-island/app/src-tauri/src/lib.rs`。
- **Job Object 主路径**：`CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，**spawn 后立即 `AssignProcessToJobObject`**；主进程消亡（含崩溃）时内核连坐整棵子树。
- `taskkill /T /F` **仅作异常兜底**（Job 分配失败时）。优雅退出仍先发信号让 Host 自己 close。
- 本机既有教训（`machine-sxs-new-exe-blocked`）：wscript/WMI 的 kill-on-close job 会秒杀子树 —— 我们**主动**使用同一机制，方向相反、正好利用。

## 6. 前端唯一 baseUrl（解 P1-3）

- `createHostSelection({ search, env, boot })` 返回 **`{ host, catalogSource, mode, baseUrl }`**；`boot` 来自 Rust 注入的 `window.__OPENCLI_BOOT__`（优先级：boot > URL query > env > 默认 43117）。
- `baseUrl` 经 **props** 一路传：`main.tsx → App → AppShell → HealthPill`（HealthPill 删除自读 env/常量的分支）。
- 验收断言：**`/health`、`/catalog`、`/events`、`/start`、`/cancel` 五端点全部命中同一随机端口**（测试注入 baseUrl 后断言各 fetch/EventSource 的 URL 前缀一致）。

## 7. 安全（解 P2-6，并守住 P0-B 基线）

- **CSP**：`connect-src` 必须容纳随机端口 → `'self' ipc: http://ipc.localhost http://127.0.0.1:*`（仅回环通配端口；不放开非回环）。
- **CORS**：生产 WebView 的真实 `Origin`（Windows 上通常 `http://tauri.localhost`，**以安装包实测捕获为准**）由 Rust 经 `OPENCLI_HOST_ALLOWED_ORIGINS` 精确注入。**禁止**「猜几个都放进去」——放宽 origin 会削弱 P0-B 的 DNS-rebinding 防线。
- **P0-B 白名单/校验一字不动**：policy（read+public+browser=false）、`commandKey===argv[0]/[1]`、强制 `-f json`、回环 bind 全部原样保留。

## 8. 打包产物

- `tauri build` 出 **NSIS + MSI**；`resources` 指向 `dist-host/` 与前端 `dist/`。
- `identifier` 用独立反域名（避免与 usage-island 等同机 Tauri 应用撞）。
- 不打包 Node 二进制（决策①代价的一部分：装机门槛 = 系统 Node>=20）。

## 9. 测试与验收

- **T0 隔离闭包 spike（开工第一步，先验证再造）**：把生成的 `dist-host/` 拷到**无任何祖先 `node_modules`** 的临时目录，用系统 node 起 Host → 断言 readiness JSON、`/health`、`/catalog`（真 spawn opencli list）、`/start`（36kr/news 真出结果）。**闭包不通过就不进后续 task。**
- 自动化测试：readiness JSON 解析与四分支（Rust 单测 + Node 侧输出格式测试）；Job Object 清理（集成测试观察子进程消亡）；前端 baseUrl 单一事实源（五端点同端口断言）；`build-host-runtime` 产物清单校验。
- **真机发布门（人工）**：装 MSI 与 NSIS 两种包 → 启动 → 目录渲染 1278 命令 → 跑 `36kr/news` 出真结果 → 关窗口后**进程树验收：`node` 与 opencli 后代全部消失**。SxS 结论以此门为准。

## 10. 风险与未决

| 风险 | 处置 |
|---|---|
| 安装后 exe / MSI / NSIS 启动器仍可能踩 SxS | 列为发布门（§9），未过不宣称通过；兜底方案=以 `tauri dev` 形态自用 |
| 30MB opencli 内置使升级需重发应用 | 决策②已接受；版本号写进 readiness JSON 便于诊断 |
| 生产 WebView Origin 与预期不符 | 安装包实测捕获后再定值，不猜 |
| Job Object 在某些策略下分配失败 | `taskkill /T` 兜底 + 退出日志标注降级 |
| 系统 Node 缺失/版本低 | 引导视图明确写出所需版本与检测到的版本 |

## 11. 任务切分（供 writing-plans）

```
T0  隔离 runtime-closure spike（先验证闭包，红则回设计）
T1  消除 .ts import（shared/*.mjs + .d.mts + 全消费点）+ Node 门槛降 20
T2  build-host-runtime 脚本 + 固定版 OpenCLI production tree
T3  readiness JSON 协议 + 四失败分支（Host 侧）
T4  Rust supervisor：Job Object + single-instance + 窗口时机 + boot 注入
T5  前端唯一 baseUrl（HostSelection→App→AppShell→HealthPill）+ 五端点同端口断言
T6  资源/CSP/CORS/installer 配置
T7  MSI+NSIS 真机闭环与进程树验收（人工门）
```
