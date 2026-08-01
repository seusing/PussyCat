# BLOCKED — 集成待裁决/外部项(2026-08-01 收口态)

机器可做的已全部做完;以下为剩余外部/待裁决项。每项含已验证事实、责任边界、
下一动作与最小复现命令。

## B1 · 带注册表的完整安装/卸载周期(含卸载保留矩阵)

- 已验证(3 点):① MSI 管理映像抽取 exit 0、拓扑与 vk 载荷齐全;② 抽出 exe
  真启动并拉起 Node 子进程、收树零孤儿;③ 数据根 `%LOCALAPPDATA%\爪爪-data`
  与安装目录分离 + purge/保留语义已由 vk-data-tool 真跑(evidence/phase5、
  phase6/installer-payload-e2e.md)。
- 未做:运行安装器写 HKCU 登记(会改写用户现有「爪爪」安装的注册表登记项)、
  登记态卸载、卸载后 data 保留断言。
- 责任边界:用户机器的安装登记状态属用户;任务书要求现有安装目录只读。
- 下一动作(用户在场或批准后机器执行):
  `爪爪_0.1.0_x64-setup.exe /S /D=C:\Users\Lauseusing\AppData\Local\爪爪`
  → 启动走完闭环 → 控制面板卸载 → 断言 `%LOCALAPPDATA%\爪爪-data` 原样保留。

## B2 · 打包窗口(WebView2)内 UI 闭环自动化

- 已验证(3 面):① dev 真栈 UI 闭环 Playwright 5/5;② 浏览器实录六项
  (phase4);③ API 层闭环 fixture E2E 16/16。窗口内逻辑与 dev 栈同一份
  React/Node 代码,差异仅 WebView 宿主与 origin(`http://tauri.localhost`,
  已入 Rust 白名单)。
- 未做:WebView2 内的自动化驱动(需 tauri-driver/WebDriver 通道)。
- 责任边界:tauri-driver 引入与其 msedgedriver 版本匹配属工具链决策。
- 下一动作:`cargo install tauri-driver` + Playwright/WebdriverIO 接
  `tauri-driver --port`,复用 e2e/vk.spec.ts 场景。

## B3 · 安装包内捆 wheel+uv 与首启 runtime 安装向导

- 已验证(3 点):① runtime 安装器四门+原子切换+坏 wheel 回滚真跑(phase5);
  ② Rust 只信 active.json 指针(fail-closed 单测);③ wheel 固定 SHA+SBOM 齐。
- 未做:把 `video_knowledge-0.1.0-py3-none-any.whl` + `uv.exe` 放进
  `bundle.resources` 并做首启向导 UI(检测无 active.json → 引导执行安装器、
  流式显示真实下载/初始化阶段)。
- 责任边界:向导 UX 文案与触发时机宜过用户;机器侧脚本与接线点已备。
- 下一动作:tauri.conf `bundle.resources` 增 `vk/`(wheel+uv);React 侧
  not-configured 状态页挂「安装解析引擎」按钮 → Node 起
  `scripts/install-vk-runtime.mjs --wheel <resource> --home %LOCALAPPDATA%\爪爪-data`。

## B4 · media-asr 重型能力装入版本化 runtime(约 3–5GB)

- 已验证(3 点):① 安装器 `--extra media-asr` 路径与 5GiB 磁盘预检已实现;
  ② 同款重栈曾按 HQ-10 批准装入 vk 开发 venv 并真跑过 10/10 语料(vk 仓
  记录);③ 无字幕语料在缺件时按能力状态 missing_dependency 诚实展示(UI 实录)。
- 未做:向版本化 runtime 再下载一份重栈(纯磁盘/带宽体量,零计费)。
- 责任边界:磁盘与带宽属用户资源(HQ-10 同类事项,批复即执行)。
- 最小复现:`node scripts/install-vk-runtime.mjs --wheel <whl> --home %LOCALAPPDATA%\爪爪-data --extra media-asr`

## B5 · Node/Tauri 层 kill 矩阵(登记安装形态)

- 已验证(3 点):① Python 层 kill 矩阵 10/10(强杀/诊断/reconcile/零自动
  扣费/重提交/完整性);② Rust Job Object 杀全树含孙进程有 cargo 行为证明
  (既有 `kill_on_job_close_terminates_the_whole_subtree`);③ Node 优雅关停
  拆 sidecar 零孤儿(冒烟门)。
- 未做:登记安装形态下 kill Node/kill Tauri 的组合矩阵(依赖 B1)。
- 下一动作:B1 完成后,taskkill Node / taskkill 爪爪.exe 各一轮,断言
  sidecar 随树消亡、重启 reconcile、零重复扣费(同 phase6 脚本法)。

## 常备规则备忘(非阻塞)

- 付费调用门:本目标全程新增真实付费 0;后续任何真实 LLM 调用先在此立项
  (vk HUMAN-QUEUE HQ-06 无未决申请)。
- vk 人工门(HQ-01~08)属上游 M 线,不由本集成代办;UI 按 machine_ready/
  partial 如实展示。
