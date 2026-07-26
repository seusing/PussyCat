# P1-A Tauri 打包 · T9 真机发布门 验收报告

- 日期：2026-07-26
- 分支：`p1-tauri-packaging`（代码 HEAD 见文末）
- 规格：`docs/specs/2026-07-25-p1-tauri-packaging-design.md`
- 计划：`docs/plans/2026-07-25-p1-tauri-packaging.md` Task 9
- 结论：**Release Candidate。** 自动门全绿；真机门 8 项通过、4 项待用户目视、1 项（MSI）未安装。

安装包本身不入库（体积）；本报告只记命令、路径、PID/CommandLine、退出码与结论。

---

## 0. 自动化门（提交前复跑）

| 门 | 命令 | 结果 |
|---|---|---|
| 前端 + server 测试 | `npx vitest run` | 31 文件 / **246 通过** |
| Rust | `cargo test`（`src-tauri`） | **13 通过** |
| 类型 | `npx tsc --noEmit` | 干净 |
| 构建 | `npm run build` | 通过 |
| Host 闭包硬闸 | `node scripts/verify-host-closure.mjs` | **8/8**，含真实 `36kr/news` 20 行 |
| 父进程存活通道 | `node scripts/verify-parent-watch.mjs` | 对照组 6s 存活 / 实验组 ~629ms 自退 |
| 空白/行尾 | `git diff --check main...HEAD` | **0**（`a354f07` 修 4 个脚手架文件 CRLF→LF） |

## 1. 产物

```
src-tauri/target/release/bundle/nsis/OpenCLI App Clone_0.1.0_x64-setup.exe   5.3 MB
src-tauri/target/release/bundle/msi/OpenCLI App Clone_0.1.0_x64_en-US.msi    9.6 MB
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

## 4. 未完成项

| 项 | 状态 | 原因 |
|---|---|---|
| 目录 UI 渲染目视 | ⏳ | 需人眼。Host 层已证 1278/175，但「渲染出来」是 UI 事实 |
| 结果表 UI 目视 | ⏳ | 同上 |
| 收藏重启持久化 | ⏳ | 需 UI 操作（点收藏 → 完全退出 → 重开） |
| Node 缺失/过低引导视图 | ⏳ | 需临时改 PATH + 目视六类错误视图之一 |
| MSI 安装 + 全表复跑 | ⏳ | 需管理员权限 |

桌面控制权限（computer-use）曾申请，**用户拒绝**，未重试。

---

## 5. 记账纪律

所有「进程是否还活着」的判定均使用 **PID + CreationDate 双因子**：只认 PID 会被 PID 复用骗，只认进程名会被上一轮残留骗，两者都会把失败读成通过。本机同时装有被复刻的 `OpenCLIApp` 0.1.36，与 `OpenCLI App Clone` 是两个不同产品，取证时未混用。

## 6. 不变式 I2 的证据边界

`taskkill /F` 只证明「父进程猝死时子树确实消失」这个**结果**，证不了是哪条通道起的作用——正常路径里 Job Object 与 stdin EOF 同时在场。stdin EOF 通道由 `scripts/verify-parent-watch.mjs` 单独证明（不建 Job Object 的站位父进程 + 零假设对照组）。两者相加才构成完整链条；仍未被任何自动化覆盖的一环是「Rust 侧确实持有写端且从不写入」，由本报告第 2/3 节「应用活着时 Host 不退、应用消亡时 Host 退」间接佐证。
