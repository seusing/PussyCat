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

**二轮设计复审吸收（3 P1 + 2 P2，同样全部经核实）**：
| 复审项 | 吸收 |
|---|---|
| P1-1 布局矛盾 + 任务图有环 | §3 `dist-host/` **镜像仓内相对拓扑**（`dist-host/src/shared/`，因 server 用相对 import）；§11 依赖序重排，闭包验证从"T0"改为 **T4 硬闸**（它消费 T1-T3 产物） |
| P1-2 production tree 不可复现 | §3 独立 **runtime lockfile 提交进 git** + `npm ci --omit=dev` + 全树 **SHA-256 清单**并校验 |
| P1-3 Job 失败/崩溃无兜底 | §5 **双通道**：Job Object（内核连坐，覆盖崩溃）+ **stdin EOF 看门狗**（恒开，覆盖 Job 分配失败）；两者皆不可用 → **fail-closed**；`taskkill /T` 降级为正常退出收尾;**强杀主进程后子树消亡**列为必测 |
| P2-4 resources 映射 | §8 `frontendDist` 载前端、`bundle.resources` **map 形式** `{"../dist-host/":"host/"}`（数组形式会落成 `_up_/…`），Rust 用 `BaseDirectory::Resource` 解析 |
| P2-5 readiness 分支 + 回归 | §4 `ready:false` 升为**协议内独立分支**（与"提前退出/非法 JSON"分开）；§9 发布门加**收藏重启持久化**与**启动→SSE→取消→cancelled** 两条原始需求回归 |
| Node 20 EOL | §2 下限 20 保留，但**推荐**写当前 LTS（22/24） |

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

- **Node 外置**：功能下限 `node >= 20`（与 opencli `engines` 持平，安装 opencli 的前提本就如此）；启动时**探测版本**，不达标 → 引导视图（写明**检测到的版本**与下限）。**注意：Node 20 已 EOL**——引导页/README 的**推荐**运行时写当前 LTS（22/24），只把 20 表述为"最低可运行"，不得表述为"推荐"（二轮复审）。
- **OpenCLI 内置**：资源目录自带 production tree，`createRequire` 天然解析到它——与决策②一致，无发现协议。

## 3. 自包含 Host runtime（解 P1-1）

新增 `scripts/build-host-runtime.mjs`，产出 `dist-host/`（Tauri `resources` 打包它）：

**布局铁律：`dist-host/` 必须镜像仓内相对拓扑**——`server/catalog-service.mjs` 用相对路径 `../src/shared/*.mjs` 引共享模块，拍平成 `dist-host/shared/` 会当场断链（二轮复审 P1-1）：

```
dist-host/
├─ server/*.mjs                     # 原样拷贝（相对 import 得以成立）
├─ src/shared/*.mjs + *.d.mts       # 与仓内同路径,见下「消除 .ts import」
├─ public/catalog.snapshot.json     # 首载 policy 来源
├─ node_modules/@jackwener/opencli@1.8.6 + prod 依赖
└─ runtime-manifest.json            # 见下：全树 SHA-256 清单
```

**可复现闭包（二轮复审 P1-2）**：`npm install pkg@1.8.6` 只钉顶层，其生产依赖仍走 semver 范围 → 不可复现。定稿做法：

1. 仓内提交**独立 runtime lockfile**：`host-runtime/package.json`（只声明 `@jackwener/opencli@1.8.6`）+ `host-runtime/package-lock.json`（提交进 git）。
2. 生成用 **`npm ci --omit=dev`**（非 `npm install`）产出 staging tree —— lockfile 决定每一层版本。
3. 对最终 tree 生成 **`runtime-manifest.json`**（每文件 SHA-256 + 总文件数），并在 CI/构建脚本里**校验**；清单变更必须随 lockfile 变更一起 review。

闭包本身**由隔离验证任务实证**（§9 硬闸），不靠推断。

**消除运行时 `.ts` import（决策③）**：
- `src/data/normalize.ts` / `src/data/catalogSchema.ts` 改为 **`.mjs` + 手写 `.d.mts`**（纯函数，无框架依赖），移到 `src/shared/`（前端与 server 共用同一份，单一事实源）。
- 消费点全改：`src/data/catalog.ts`、`server/catalog-service.mjs`、`scripts/sync-catalog.mjs`、各测试。
- 连带**拆掉** `server/index.mjs` 的「先断言 Node>=23 再动态 import」那套 guard —— 它当初正是为 type-stripping 而立；改为 **`>=20` 版本断言**（静态 import 即可，无 `.ts` 依赖后不再有「断言前解析依赖图」的陷阱）。

## 4. 启动协议（解 P1-4）

**Host 侧**（`server/index.mjs`）：
- 端口：沿用 **`OPENCLI_HOST_PORT=0`**（不引入 `--port`，避免两套入口）；listen 后取实际端口。
- **成功**：向 stdout 打印**恰一行**机器可读 JSON，随后照常人读日志：
  ```json
  {"opencliHostReady":true,"port":54321,"pid":1234,"opencliVersion":"1.8.6","policyCommands":277,"parentWatch":true}
  ```
  （`parentWatch` = Host 是否真的挂上了 stdin EOF 看门狗；供 supervisor 判 fail-closed，见 §5 第 3 条。）
- **失败**（catalog 缺失/opencli 解析失败/listen 失败等）：打印一行
  ```json
  {"opencliHostReady":false,"error":{"summary":"...","detail":"..."}}
  ```
  并以非零码退出。

**Rust 侧**读取契约：
- 逐行读 stdout，**首个含 `opencliHostReady` 的 JSON 行**即判定；
- **持续排空 stdout/stderr 直到进程退出**（不得读到首行就停 —— 管道满会背压死锁子进程）；排空内容转 Tauri 日志。
- **五类分支**各自映射错误视图（二轮复审 P2-5：`ready:false` 是**协议内的合法失败**，必须与"进程异常"分开诊断，文案与日志不得混为一谈）：

| # | 分支 | 判定 | 用户可见 |
|---|---|---|---|
| ① | spawn 失败 | 创建进程即错（node 不存在/不可执行） | 「未找到 Node」引导页 |
| ② | 版本不达标 | 预探测 `node --version` < 20 | 「Node 版本过低」引导页（写明检测到的版本；推荐当前 LTS） |
| ③ | **协议内失败** | 收到合法 `{"opencliHostReady":false,"error":{...}}` | 直接展示服务端 `summary`/`detail`（Host 自知的失败，如 catalog 缺失、端口占用） |
| ④ | readiness 超时 | 默认 15s 未收到判定行 | 「Host 启动超时」+ 已排空的 stderr 尾部 |
| ⑤ | 进程异常 | 子进程提前退出，或输出的 JSON 非法/缺字段 | 「Host 异常退出」+ 退出码 + stderr 尾部 |
| ⑥ | **托管不可用**（T5 实现期新增，评审接受） | Job Object 不可用**且** Host 未装 stdin 看门狗（`parentWatch:false`）→ 无法保证进程回收 → **fail-closed 不启动**；亦收资源目录解析失败 | 「无法安全托管 Host」+ 原因 |

> ⑥ 是 §5「fail-closed」在错误面上的落点：把它塞进 ⑤ 会把"我们拒绝托管"伪装成"Host 挂了"，诊断被污染。**T6 的错误视图路由必须覆盖全部六个 `kind`**（漏 `supervision-unavailable` 会让 fail-closed 变白屏）。
>
> **实际 `kind` 字符串（实现即契约，T6 已按此路由；本表早期草稿写过 `host-failed`/`timeout`，以下为准）**：
> `node-missing` / `node-too-old` / `host-reported-failure` / `readiness-timeout` / `process-failed` / `supervision-unavailable`。
> 路由由三重保证：Rust 侧穷尽 `match`（编译期）+ 测试断言六个 kind 都是页面分派表的 key + 未知 kind 兜底视图（永不白屏）。

## 5. Rust supervisor（解 P2-5）

- **single-instance 插件最先注册**，早于任何 Host bootstrap —— 否则第二实例会先拉起第二个 Node 再被劝退。参考同机 `usage-island/app/src-tauri/src/lib.rs`。
**双通道清理（二轮复审 P1-3：主进程崩溃时 `taskkill` 无人执行，兜底形同虚设）**：

1. **主路径 · Job Object**：`CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，**spawn 后立即 `AssignProcessToJobObject`**。主进程消亡（含**崩溃/强杀**）时由**内核**连坐整棵子树 —— 不依赖任何代码还能运行。
2. **并行路径 · 父进程存活通道（stdin EOF 看门狗，恒开）**：Rust 保留 Host 的 stdin 管道写端且不写入；Host 侧监听 `process.stdin` 的 `end`/`close` → **自行优雅退出**（先 `app.close()` 收 SSE 与在途 run，再 exit）。父进程一旦消失，写端关闭 → 子进程立刻收到 EOF。这条**不依赖 Job**，覆盖 Job 分配失败的场景。
3. **Job 分配失败 → 记录降级并继续（依赖通道 2）**；若**通道 2 也不可用** → **fail-closed**：不启动 Host，直接错误视图（`kind=supervision-unavailable`），绝不留无主子进程。
   > **「通道 2 可用」必须是验证而非断言（T5 评审 I-1）**：Rust 侧「设了 `OPENCLI_HOST_PARENT_WATCH=1`」不等于 Host 真装了看门狗（`dist-host/` 是构建产物，可能版本漂移；且 `Stdio::piped()` 后 `child.stdin` 恒为 `Some`，光判它永远为真、fail-closed 形同虚设）。判据改为 **readiness JSON 里 Host 自报的 `parentWatch:true`**，即 `job.is_none() && !parent_watch` 才 fail-closed。
4. `taskkill /T /F` 仅用于**正常退出路径**的最后收尾（主进程尚活着，能执行）；不再把它当崩溃兜底。
5. 优雅退出顺序：窗口关闭 → 关 stdin（触发通道 2）→ 等待至多 2s → 未退则 `taskkill /T /F` → Job 关闭作最终保险。

- 本机既有教训（`machine-sxs-new-exe-blocked`）：wscript/WMI 的 kill-on-close job 会秒杀子树 —— 我们**主动**使用同一机制，方向相反、正好利用。
- **验收必测**：`taskkill /F` 强杀 Tauri 主进程（不给它执行任何清理代码的机会）后，`node` 与 opencli 后代**全部消失**（§9）。

## 6. 前端唯一 baseUrl（解 P1-3）

- `createHostSelection({ search, env, boot })` 返回 **`{ host, catalogSource, mode, baseUrl }`**；`boot` 来自 Rust 注入的 `window.__OPENCLI_BOOT__`（优先级：boot > URL query > env > 默认 43117）。
- `baseUrl` 经 **props** 一路传：`main.tsx → App → AppShell → HealthPill`（HealthPill 删除自读 env/常量的分支）。
- 验收断言：**`/health`、`/catalog`、`/events`、`/start`、`/cancel` 五端点全部命中同一随机端口**（测试注入 baseUrl 后断言各 fetch/EventSource 的 URL 前缀一致）。

## 7. 安全（解 P2-6，并守住 P0-B 基线）

- **CSP**：`connect-src` 必须容纳随机端口 → `'self' ipc: http://ipc.localhost http://127.0.0.1:*`（仅回环通配端口；不放开非回环）。
- **CORS**：生产 WebView 的真实 `Origin`（Windows 上通常 `http://tauri.localhost`，**以安装包实测捕获为准**）由 Rust 经 `OPENCLI_HOST_ALLOWED_ORIGINS` 精确注入。**禁止**「猜几个都放进去」——放宽 origin 会削弱 P0-B 的 DNS-rebinding 防线。
- **P0-B 白名单/校验一字不动**：policy（read+public+browser=false）、`commandKey===argv[0]/[1]`、强制 `-f json`、回环 bind 全部原样保留。

## 8. 打包产物

- `tauri build` 出 **NSIS + MSI**。
- **前端与 Host 走两条不同机制,不可混用（二轮复审 P2-4）**：
  - `build.frontendDist` 承载前端 `dist/`（webview 内容）；
  - `bundle.resources` **只**承载 Host runtime，且**必须用 map 形式**把它落到运行时 `host/`：
    ```json
    "resources": { "../dist-host/": "host/" }
    ```
    原因：Tauri 的 `resources` **保留相对路径**，写成数组形式的 `"../dist-host/**"` 会被落成 `_up_/dist-host/...`，设计图里的 `resources/host/server/index.mjs` 直接落空。
  - Rust 侧一律用 **`BaseDirectory::Resource`** 解析（`path().resolve("host/server/index.mjs", BaseDirectory::Resource)`），不手工拼路径。
- `identifier` 用独立反域名（避免与 usage-island 等同机 Tauri 应用撞）。
- 不打包 Node 二进制（决策①代价的一部分：装机门槛 = 系统 Node>=20）。

## 9. 测试与验收

- **隔离闭包硬闸（T4；二轮复审 P1-1 修正了它的位置——它消费 T1-T3 的产物，不可能排在它们之前）**：把生成的 `dist-host/` 拷到**无任何祖先 `node_modules`** 的临时目录，用系统 node 起 Host → 断言 ①readiness JSON 合法 ②`/health` ③`/catalog`（真 spawn opencli list，1278 命令）④`/start` 跑 `36kr/news` 出真结果 ⑤`runtime-manifest.json` 校验通过。**此闸不过，T5 及以后一律不开工**（Rust/前端/打包全部依赖闭包成立）。
- 自动化测试：readiness JSON 解析与**五分支**（Rust 单测 + Node 侧输出格式测试）；进程清理**两通道**（Job Object 正常退出 + **强杀 Tauri 后子树消亡**）；前端 baseUrl 单一事实源（五端点同端口断言）；`build-host-runtime` 产物 SHA-256 清单校验。
- **真机发布门（人工）**：装 MSI 与 NSIS 两种包 → 启动 → 目录渲染 1278 命令 → 跑 `36kr/news` 出真结果 → 关窗口后**进程树验收：`node` 与 opencli 后代全部消失**；再 `taskkill /F` 强杀主进程复验一次子树消亡。**外加两条原始需求回归（二轮复审 P2-5）**：
  - **收藏重启后持久化**：收藏站点/命令 → 完全退出应用 → 重开 → 收藏仍在（验证 WebView 的 localStorage 分区在打包形态下真的持久）。
  - **运行闭环**：启动 → SSE 输出可见 → 取消 → 终态为 `cancelled`（`done` 事件收口）。

  SxS 结论以此门为准。

## 10. 风险与未决

| 风险 | 处置 |
|---|---|
| **窗口先建 + setup 在主线程 → 启动失败路径会冻结白窗**（T5 评审 C1，读 tauri-2.11.5 `app.rs:2521` 实证：配置窗口先建、用户 `setup` 由 `Ready` 事件在主线程事件循环内触发） | `probe_node` 必须有超时；**T6 硬性要求**：`tauri.conf.json` 的窗口改 `create:false`（或 `windows: []`）+ **boot 移出主线程**，就绪后再建窗 |
| **Tauri 资源路径是 verbatim 形式（`\\?\C:\…`），node 不认** —— T6 `cargo run` 真跑抓出的 P0：Host 当场 `EISDIR: lstat 'C:'` 退出，三门全绿但打包后永远起不来 | 调用方用 `dunce::simplified()` 归一化后再传给 node（`node_friendly()` + 回归测试）。**教训：跨进程传路径必须按对端的路径方言归一化，编译与单测都看不见这层** |
| **启动期约 1 秒无任何窗口**（失败路径最坏 15s 才出错误窗） | 这是"不冻结白窗"的直接代价（窗口 `create:false` + boot 在后台线程）。未加 splash：关 splash 会让窗口表变空触发 `ExitRequested`，属新增竞态。**T9 验收时"启动 1s 无窗"是预期行为，不是缺陷** |
| **I2（父进程猝死→Host 靠 stdin EOF 自退）端到端未被证过** | 现有两条测试用的是 `child.stdin.end()`（**活着的**父进程优雅关写端），不等价于父进程猝死；本机沙箱自身会连坐回收子树，探针无法证伪（评审三级探针实测，含零假设对照组）。**只能由 §9 的 T9 人工门（`taskkill /F` 强杀主进程后查子树）兜住——不得把那两条绿测当作 I2 已验证** |
| 安装后 exe / MSI / NSIS 启动器仍可能踩 SxS | 列为发布门（§9），未过不宣称通过；兜底方案=以 `tauri dev` 形态自用 |
| 30MB opencli 内置使升级需重发应用 | 决策②已接受；版本号写进 readiness JSON 便于诊断 |
| 生产 WebView Origin 与预期不符 | 安装包实测捕获后再定值，不猜 |
| Job Object 在某些策略下分配失败 | `taskkill /T` 兜底 + 退出日志标注降级 |
| 系统 Node 缺失/版本低 | 引导视图明确写出所需版本与检测到的版本 |

## 11. 任务切分（供 writing-plans）

**依赖序已修正（二轮复审 P1-1：原 T0 消费 T1/T2 产物却排在其前，任务图有环）**：

```
T1  消除 .ts import（src/shared/*.mjs + .d.mts + 全消费点）+ Node 门槛 23→20
T2  readiness JSON 协议 + 五分支（Host 侧，纯 Node，可独立测）
T3  host-runtime lockfile（npm ci --omit=dev）+ build-host-runtime 脚本 + SHA-256 清单
T4  🔴 隔离闭包硬闸：无祖先 node_modules 的临时目录跑通 readiness/health/catalog/start + 清单校验
    ——不过则回 T1-T3，T5+ 一律不开工
T5  Rust supervisor：Job Object + stdin EOF 看门狗 + fail-closed + single-instance（早于 bootstrap）
T6  Rust 窗口时机 + boot 配置注入 + 五类错误视图
T7  前端唯一 baseUrl（HostSelection→App→AppShell→HealthPill）+ 五端点同端口断言
T8  资源 map（`{"../dist-host/":"host/"}`）/ CSP connect-src / CORS 真实 Origin 捕获 / installer 配置
T9  MSI+NSIS 真机门（人工）：安装→目录 1278→跑 36kr/news→关窗口进程树净→强杀复验→
    收藏重启持久化→启动/SSE/取消 done:cancelled
```
