# P1-A Tauri 打包 · T9 真机发布门 验收报告

- 日期：2026-07-26
- 分支：`p1-tauri-packaging`（代码 HEAD 见文末）
- 规格：`docs/specs/2026-07-25-p1-tauri-packaging-design.md`
- 计划：`docs/plans/2026-07-25-p1-tauri-packaging.md` Task 9
- 结论：**通过。** 自动门全绿；真机发布门 14 项全部通过（含最终候选包上的四项人工门，见第 11 节）。

安装包本身不入库（体积）；本报告只记命令、路径、PID/CommandLine、退出码与结论。

---

## 0. 自动化门（数字为终审修复 `1952bb5` 之后的最新一轮）

| 门 | 命令 | 结果 |
|---|---|---|
| 前端 + server 测试 | `npx vitest run` | 32 文件 / **258 通过** |
| Rust | `cargo test`（`src-tauri`） | **17 通过**（安全收口后为 **19**，见第 10 节） |
| 类型 | `npx tsc --noEmit` | 干净 |
| 构建 | `npm run build` | 通过 |
| Host 闭包硬闸 | `node scripts/verify-host-closure.mjs` | **8/8**，含真实 `36kr/news` 20 行（M-3 加了「与源码同步」一条后为 **9/9**） |
| 父进程存活通道 | `node scripts/verify-parent-watch.mjs` | 对照组 6s 存活 / 实验组 ~629ms 自退 |
| 空白/行尾 | `git diff --check main...HEAD` | **0**（`a354f07` 修 4 个脚手架文件 CRLF→LF） |

## 1. 产物

出自 HEAD `1952bb5`（终审修复之后重新构建）：

```
src-tauri/target/release/bundle/nsis/OpenCLI App Clone_0.1.0_x64-setup.exe   5 336 448 B
src-tauri/target/release/bundle/msi/OpenCLI App Clone_0.1.0_x64_en-US.msi    9 640 146 B
```

---

## 2. 第一轮：从 Claude 应用内安装 —— **SxS 结论作废，功能结论有效**

### 2.1 为什么作废

`Start-Process` 拉起的 NSIS 安装被 **MSIX 容器文件重定向**：

| 观测 | 值 |
|---|---|
| 注册表 `InstallLocation` | `"C:\Users\Lauseusing\AppData\Local\OpenCLI App Clone"` |
| 进程实际加载 | `…\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\OpenCLI App Clone\host\server\index.mjs` |
| 两处 exe SHA-256 | `22D52D5B…1FA03CF`，**相同** → 同一份文件的两个视图 |

子进程继承容器，故凡此环境拉起的都在容器内。而本机 SxS 的已知特征是「Claude 区豁免、别处 14001」——**在可能被豁免的路径上取得的启动成功，不能外推到真实安装路径**。故 SxS 一项在本轮判为无效，改由第 3 节裁定。

（报告完成后已删除该容器副本，避免它继续遮蔽同名真实路径。）

### 2.2 本轮仍然有效的证据

| 项 | 证据 |
|---|---|
| NSIS 静默安装 | `/S` → exit **0**；3596 文件；`host/{node_modules,public,server,src,runtime-manifest.json}` 齐；`@jackwener/opencli` 在位 |
| readiness | `{"opencliHostReady":true,"port":53301,"pid":13420,"opencliVersion":"1.8.6","policyCommands":277,"parentWatch":true}`；日志 `通道1=true 通道2=true` |
| 关窗口（`CloseMainWindow()`，非强杀） | 主进程 / `node.exe(13420)` / `msedgewebview2.exe(43952)` **全部消失**（PID+CreationDate 双因子核验） |
| `taskkill /F`（**不带 `/T`**）强杀主进程 | 强杀前抓到 8 个后代（Host node、WebView 主进程 + crashpad/gpu/utility×2/renderer、conhost）；强杀后**逐个复验全部消失** |
| **opencli 孙进程连坐** | 见 2.3 |
| MSI 安装 | `msiexec /qn` → **1603**；日志实证 **Error 1925「You do not have sufficient privileges to complete this installation for all users of the machine」** → per-machine 包需提权，**非包缺陷**；UAC 受 UIPI 保护无法自动驱动 |

### 2.3 opencli 孙进程：一次返工

头两轮强杀快照只拍到 `node + webview + conhost`，**没有 opencli**。没有据此写成「opencli 不存在」，而是回查 `server/run-manager.mjs` 确认它确实 `spawn(node, [opencliEntry, ...argv])`——是 600ms 的粗快照错过了窗口。改用快速轮询后：

```
opencli 子进程 pid = 22048  (t=10ms)
父 = 25672 (Host node)
命令行 = "…\node.exe" "…\OpenCLI App Clone\host\node_modules\@jackwener\opencli\…"
taskkill /F 27456 (不带 /T) exit=0
→ 主进程(27456) 存活 = False
→ Host node(25672) 存活 = False
→ opencli 后代(22048)  存活 = False
```

---

## 3. 第二轮：用户从资源管理器真实安装 —— **SxS 裁定通过**

| 观测 | 值 |
|---|---|
| 主进程 | pid **33580**，CommandLine `"C:\Users\Lauseusing\AppData\Local\OpenCLI App Clone\opencli-app-clone.exe"` |
| Host node | pid **21752**，CommandLine `"node" "C:\Users\Lauseusing\AppData\Local\OpenCLI App Clone\host\server\index.mjs"` |
| 后代总数 | 8 |
| **命中 Claude 容器路径的进程数** | **0** |
| 卸载注册表项 | `HKCU\…\Uninstall\OpenCLI App Clone`，`InstallLocation` = 真实 `%LOCALAPPDATA%` |
| MSI 安装记录 | **无**（`HKLM\…\Installer\UserData\*\Products\*\InstallProperties` 未见）→ 本轮只装了 NSIS |

→ **SxS 14001 在真实安装路径上未复现，应用正常启动。** 这是本项的权威结论。

对同一实例的功能复验（Host 监听 **53557**，经生产 Origin `http://tauri.localhost`）：

| 项 | 结果 |
|---|---|
| `/catalog` | **1278 命令 / 175 站点** |
| `36kr/news` | **142** 个 SSE `output` → 终态 `outcome=success`，`exitCode=0`，返回真实条目（中文标题/摘要/日期） |
| 取消闭环 | `/cancel` → HTTP **204** → 终态 `outcome=cancelled` |

---

## 4. 第三轮：启动失败引导视图（终审 I-1）

终审指出六类错误视图**从未被执行过一次**：Rust 侧只对 `include_str!` 的 HTML 做子串匹配，从不执行页面脚本；真机侧该项挂着未做。若自定义 scheme 在打包形态下接不上，`open_error_window` 返 `Err` → `app.exit(1)` → **进程无声退出，比白屏更糟**。

剥掉 PATH 里的 node 启动已安装的 exe：

| 观测 | 值 |
|---|---|
| 启动前 `Get-Command node` | **False**（PATH 已只剩 `System32;Windows`） |
| 主进程 | **存活** —— 没有走 `app.exit(1)` 静默退出 |
| 窗口标题 | **`OpenCLI App Clone — 启动失败`**（错误窗专属，与主窗不同） |
| 日志 | `[boot] Host 启动失败[node-missing]: 未找到可执行的 Node：node --version 无法执行: program not found` |

**结论**：自定义 `opencli-error://` scheme 在打包形态下接得上，失败路径会真的开出一个窗，分类判定正确。

**射程边界**（不夸大）：窗口标题由 Rust builder 设置，**证明的是"错误窗被创建"，不是"页面 DOM 画出来了"**。DOM 那一半由 `src/errorPage.test.ts` 用 jsdom `runScripts` 真执行页面脚本覆盖（11 用例：六类标题 / 兜底视图 / 无 kind / 原型链键 / detail·logDir 显隐 / 文本转义），并已变异验证（摘掉 `hasOwnProperty` 守卫 → 标题变空字符串，如期变红）。两者相加覆盖这条路径；未被任何自动化直接观测的一环是"自定义协议的响应体确实被 WebView 渲染成了那个 DOM"。

## 5. 未完成项 —— **已于第 11 节全部补齐（本节保留为当时的待办记录）**

| 项 | 状态 | 原因 |
|---|---|---|
| 目录 UI 渲染目视 | ✅ 见 11.1 | 需人眼。Host 层已证 1278/175，但「渲染出来」是 UI 事实 |
| 结果表 UI 目视 | ✅ 见 11.1 | 同上 |
| 收藏重启持久化 | ✅ 见 11.1 | 需 UI 操作（点收藏 → 完全退出 → 重开） |
| MSI 安装 + 全表复跑 | ✅ 见 11.2 | 需管理员权限 |

桌面控制权限（computer-use）曾申请，**用户拒绝**，未重试。

**重要**：第 2–4 节的证据取自 `6af23ea` 时的安装包；第 6 节取自终审修复
`1952bb5`。M-10 与闭包同步闸随后又修改了运行时及打包输入。当前唯一候选包已在第 10 节
从 `eecb23f` 重建；上表剩余项必须使用第 10 节记录的 SHA-256 对应产物。

---

## 6. 第四轮：终审修复后的产物复验（HEAD `1952bb5`）

跑的是 `src-tauri/target/release/opencli-app-clone.exe` —— 与打进两个安装包的是同一个二进制。

### 6.1 环境注入被封死（I-3 的端到端证明）

先在环境里塞进三个变量再启动应用：

```
OPENCLI_HOST_ADDRESS=0.0.0.0
OPENCLI_HOST_CATALOG_PATH=C:\definitely\not\here.json
OPENCLI_HOST_MAX_CONCURRENT_RUNS=999
```

| 观测 | 值 | 说明 |
|---|---|---|
| 窗口标题 | **`OpenCLI App Clone`** | 是主窗，不是「启动失败」。若 `CATALOG_PATH` 漏进去，Host 会读不到快照 → `host-reported-failure` → 弹错误窗。**注入生效与否在这里是两种完全不同的可见结果**，不是靠断言细节区分 |
| Host 监听地址 | **`127.0.0.1:63169`** | `Get-NetTCPConnection`。注入的 `0.0.0.0` 没有生效，「回环 bind」这条冻结契约守住 |

### 6.2 功能复验

| 项 | 结果 |
|---|---|
| `/catalog` | HTTP 200，**1278 命令 / 175 站点** |
| `36kr/news` | **144** 个 SSE `output` → `outcome=success` |
| 取消闭环 | `/cancel` → **204** → `outcome=cancelled` |
| 关窗口 | 主进程 1 → 0；**遗留 Host node = 0** |

---

## 7. 记账纪律

所有「进程是否还活着」的判定均使用 **PID + CreationDate 双因子**：只认 PID 会被 PID 复用骗，只认进程名会被上一轮残留骗，两者都会把失败读成通过。本机同时装有被复刻的 `OpenCLIApp` 0.1.36，与 `OpenCLI App Clone` 是两个不同产品，取证时未混用。

## 8. 不变式 I2 的证据边界

`taskkill /F` 只证明「父进程猝死时子树确实消失」这个**结果**，证不了是哪条通道起的作用——正常路径里 Job Object 与 stdin EOF 同时在场。stdin EOF 通道由 `scripts/verify-parent-watch.mjs` 单独证明（不建 Job Object 的站位父进程 + 零假设对照组）。两者相加才构成完整链条；仍未被任何自动化覆盖的一环是「Rust 侧确实持有写端且从不写入」，由本报告第 2/3 节「应用活着时 Host 不退、应用消亡时 Host 退」间接佐证。

## 9. M-10：`Command::new("node")` 的 Windows 搜索序实证

终审把这一项列为「待确认」：supervisor 以未限定路径的
`std::process::Command::new("node")` 探测并启动 Node；若 Windows 优先搜索应用自身目录，
安装目录旁的同名 `node.exe` 会先于 PATH 中的系统 Node 被执行。

2026-07-26 用 Rust 1.97.1 做最小对照实验：

1. 编译 `launcher.exe`，内部只执行 `Command::new("node").arg("--version").output()`。
2. 在 `launcher.exe` 同目录放一个实验用 `node.exe`，只打印
   `FAKE_NODE_FROM_APPLICATION_DIR` 和自身绝对路径。
3. 从 launcher 目录之外的兄弟目录启动；PATH 中的 Node 明确为
   `C:\Program Files\nodejs\node.exe`。
4. 同一进程调用 `where.exe node.exe`，返回的仍是
   `C:\Program Files\nodejs\node.exe`，确认实验用文件没有进入 PATH。

实际输出：

```text
launcher=...\app\launcher.exe
cwd=...\cwd
where=C:\Program Files\nodejs\node.exe
status=exit code: 0
stdout=FAKE_NODE_FROM_APPLICATION_DIR
fake_exe=...\app\node.exe
```

**裁决：M-10 成立。** Rust 标准库在本机 Windows 上的实际行为确实让应用目录中的
`node.exe` 胜过 PATH Node；`probe_node` 与 `start_host` 当前都受此搜索序影响。

**本阶段处置：接受并进入 P1-B 安全 backlog，不阻塞 P1-A 合并。** 当前 NSIS 是未签名的
per-user 安装，安装目录与应用本体同属当前用户可写；能投放同目录 `node.exe` 的主体也能替换
应用本体，未新增更高权限边界。后续引入代码签名、自动更新或机器级安装前，应把 Node 解析为
经校验的绝对路径，并让版本探测与 Host 启动复用同一个解析结果；回归测试需放置同目录诱饵
`node.exe`，证明它不再被命中。同轮一并审计生产路径里的未限定系统命令（当前还有
`Command::new("taskkill")`），避免只修 Node 而留下同类搜索序入口。

> **后续（2026-07-26 同日）**：上述处置未等到签名/更新阶段，已在分支 `p1b/security-unqualified-commands` 实施。
> 生产路径共三处未限定命令（`node` ×2 + `taskkill` ×1，其余 `node`/`tasklist` 均在 `cfg(test)` 内），一并修完：
> Node 经 `resolve_program` 只从 PATH 解析成绝对路径并由 `probe_node` → `start_host` 复用同一结果；
> `taskkill` 解析到 System32 绝对路径。同目录诱饵回归测试已就位并变异验证（摘掉应用目录跳过 → 断言「应用目录里的诱饵被选中了」如期变红）。
> 本节其余内容保留为当时的裁决记录，不改写。

## 10. 第五轮：安全收口后的最终候选包（HEAD `eecb23f`）

M-10 收口（`d14238c`）与 dist-host/源码同步硬闸（`eecb23f`）已合入 `main`。为保证
人工发布门验证的正是最终代码，2026-07-26 重新执行：

```text
npm run tauri build
```

构建链包含前端 `tsc + vite build`、`build-host-runtime`、Rust release、NSIS 与 MSI；
命令成功退出，总耗时约 228.3 秒。构建前后 Git 工作区均干净，Tauri CLI 没有写回跟踪文件。

完整 provenance：

```text
Git HEAD: eecb23f9d0973961e445e351bc89e7acada854d9
```

| 产物 | 字节数 | 生成时间（Asia/Shanghai） | SHA-256 |
|---|---:|---|---|
| `src-tauri/target/release/bundle/nsis/OpenCLI App Clone_0.1.0_x64-setup.exe` | 5,343,609 | 2026-07-26T19:22:48.0524334+08:00 | `163EBA7E1BE2BF70E516105FCEC75889E78281D4F36E3109342BE2C8448DA285` |
| `src-tauri/target/release/bundle/msi/OpenCLI App Clone_0.1.0_x64_en-US.msi` | 9,648,338 | 2026-07-26T19:23:06.3130000+08:00 | `4746DAA8461F282799A61513C1DF001A5D00829C4E6E9B29E1E2BAF1444FB2A1` |

第 5 节四项人工发布门只认本节两个哈希对应的包：MSI 安装、目录 UI 目视、结果表 UI
目视、收藏后完全退出并重开确认星标。早期安装包与本节哈希不一致时，其目视结果不计入最终门。

---

## 11. 第六轮：最终候选包上的人工发布门 —— **全部通过**

在第 10 节两个哈希对应的包上完成，由用户本人在真实桌面操作、我按取证纪律核实客观痕迹。

### 11.1 NSIS 轮

| 项 | 结果 |
|---|---|
| 目录 UI 渲染 | ✅ 标题栏 `1278 条 · 22:21 更新`，左栏按站点分组渲染 |
| 结果表 UI | ✅ `36kr/news` 正常出表 |
| 取消闭环 UI | ✅ 右栏终态「已取消」，附「复制日志 / 重新执行」 |
| 错误路径 UI | ✅ 见 11.3（顺带验到，非计划项） |
| **收藏重启持久化** | ✅ 收藏 → 完全退出 → 重开，星标仍在 |

### 11.2 MSI 轮

| 观测 | 值 |
|---|---|
| `InstallSource` | `…\opencli-app-clone\src-tauri\target\release\bundle\msi\` —— **确认装的是本仓这次的包**，不是旧副本 |
| `InstallLocation` | `C:\Users\Lauseusing\AppData\Local\OpenCLI App Clone\` |
| 卸载登记 | `HKLM\…\Uninstall\{33F4F989-5FE9-4226-981E-DCCBC58798BE}` |
| 启动 + 目录 | ✅ 装得上、起得来、渲染 1278 条 |

功能面未在 MSI 轮重跑：与 NSIS 是同一个 `opencli-app-clone.exe`，第 6 节已在该二进制上端到端验过。

**⚠️ 装完抓到的包装卫生问题（非 P1-A 阻塞项，记 backlog）**：NSIS 与 MSI **装进了同一个目录**，
机器上因此并存两份安装登记（HKCU 一份 + HKLM 一份），指向同一份文件。卸载任一个都会删掉
另一个仍声称拥有的文件，留下半残状态。发布前应让两种包互斥（安装时检测并劝退）或分目录。
本机重叠状态已按第 13 节清理；产品层问题仍留 backlog。

### 11.3 顺带验到：策略拒绝路径（非缺陷）

用户点 `xiaohongshu/login` 得到 `Command is outside the P0-B execution policy`。该命令带
`write` + `浏览器` 双徽章，而冻结策略是 `access=read && strategy=public && browser=false`
（1278 中仅 277 条），**服务端拒绝即设计行为**；错误摘要、详情展开、重试、复制日志四件套均正常。

**由此暴露的真 UX 缺口（记 backlog，归 P1-B 体验层）**：徽章与策略前端本地即可判断，
应用却让用户点下「运行任务」再等一个来回才报错。应改为运行按钮置灰 + 就地说明原因，
与收藏的「失效灰显不删」同理。

---

## 12. 最终裁决

**T9 真机发布门全部通过。** 第 5 节四项已在最终候选包上补齐，无遗留待验项。

进入 backlog 的三条（均不阻塞本阶段）：
1. NSIS/MSI 同目录并存 → 安装互斥或分目录（见 11.2）
2. 策略外命令仍可点击运行 → 运行按钮置灰 + 就地说明（见 11.3）
3. M-2 / M-9 / M-11（终审 Minor，见 `.superpowers/sdd/progress.md`）

---

## 13. T9 后机器卫生：移除重叠 MSI，保留 NSIS

2026-07-27 按「先取证、再卸 MSI、最后用第 10 节最终 NSIS 修复覆盖」执行，避免 MSI 卸载
共享目录后留下只有登记、没有主程序的半残 NSIS。

### 13.1 清理前

| 登记 | Registry key | InstallLocation |
|---|---|---|
| NSIS | `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenCLI App Clone` | `C:\Users\Lauseusing\AppData\Local\OpenCLI App Clone` |
| MSI | `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\{33F4F989-5FE9-4226-981E-DCCBC58798BE}` | 同上 |

MSI 的 `InstallSource` 为本仓
`src-tauri\target\release\bundle\msi\`；ProductCode
`{33F4F989-5FE9-4226-981E-DCCBC58798BE}`。

### 13.2 卸载与修复

应用退出后，以管理员权限执行：

```text
msiexec /x {33F4F989-5FE9-4226-981E-DCCBC58798BE} /passive /norestart /L*v <log>
```

退出码 **0**；Windows Installer 日志记录
`Removal completed successfully` / `删除成功或错误状态: 0`。卸载后共享目录只剩
`host/` 与 NSIS 的 `uninstall.exe`，证明「卸一个会破坏另一个」不是理论推断。

随后先校验最终 NSIS：

```text
SHA-256 = 163EBA7E1BE2BF70E516105FCEC75889E78281D4F36E3109342BE2C8448DA285
```

再以 `/S` 修复覆盖。最终安装树恢复为 **3596 文件 / 34,700,503 bytes**。

### 13.3 清理后验收

| 项 | 结果 |
|---|---|
| 卸载登记数 | **1** |
| 保留登记 | 仅 HKCU NSIS |
| MSI ProductCode key | 不存在 |
| 已安装主程序 | `opencli-app-clone.exe`，版本 `0.1.0`，9,303,552 bytes |
| Host 启动命令 | 绝对 Node：`C:\Program Files\nodejs\node.exe ...\host\server\index.mjs` |
| Host 监听 | `127.0.0.1:<随机端口>` |
| `/health` | HTTP **200**，opencli `1.8.6` |
| 强制关闭主进程后 | 主进程与 Host node 遗留数 **0** |

机器当前只保留 NSIS 安装；第 12 节的「安装互斥或分目录」仍是未来发行前的产品 backlog，
本节只完成当前机器的重叠状态处置。

## 14. 前向注记：P1-A.1 源码策略与已发布包分叉

本报告前述 `policyCommands: 277` 是最终候选包 `eecb23f` 的真实运行记录，保持原值。
后续 P1-A.1 在源码策略中引入 deny-only 命令覆盖表，并显式收回
`paperreview/review`；因此后续源码构造出的执行策略为 **276 条**。

本次策略收口没有重打安装包，也没有产生新的 SHA-256 或候选包基线。当前机器上已安装的
NSIS 包仍对应本报告记录的 277 条策略。下一次可发布节点重打包时，应以新产物替换候选包
基线，并重新记录 readiness 中的 `policyCommands` 与产物哈希。
