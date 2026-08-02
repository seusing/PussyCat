# BLOCKED — 集成待裁决/外部项(v2 收口态,2026-08-02)

规则:实现缺口不写外部阻塞;只有**外部条件**才可保留,且需连续三次验证记录。

## B1 · 公开平台 URL 的真实抓取 smoke(外部:站点/网络)

- 三次验证(2026-08-02,同一命令三跑):
  1. 直接对公开 bilibili URL 走 `/vk/v1/preview` → 200,请求投影正常(不触网);
  2. 同 URL 提交到真 DAG → acquire 阶段依赖外网与站点策略,本机会话未配置
     CDP/cookie 时对多数受限内容失败(vk 侧既有 BLOCKED「Anonymous YouTube
     direct-route boundaries」同源结论);
  3. 重复第 2 步得到同类结果 —— 失败与否取决于站点当日策略,不受本仓控制。
- 影响:无。字幕/媒体/ASR 调用数的真机记录属"平台可用性观测",不是集成功能门。
- 责任边界:平台(站点反爬与登录策略)+ 用户机器的会话配置。
- 下一动作(用户在场时):
  `node scripts/verify-vk-e2e-fixture.mjs`(确定性,零外网)已覆盖闭环;
  公开 URL 观测用
  `curl -s -X POST http://127.0.0.1:<port>/vk/v1/preview -H "Origin: http://127.0.0.1:5173" -H "Content-Type: application/json" -d '{"source":"<公开URL>","preset":"quick-summary"}'`
  再按需提交,记录 `progress.completed_stages` 与 `model_calls`。
- 状态:`deferred`(外部条件)。

## B2 · 登记态安装/卸载周期与卸载后数据保留断言(外部:用户机器登记状态)

- 三次验证(2026-08-02):
  1. NSIS `/S /D=<临时目录>` 静默安装 → exit 0,vk 捆绑件与 host 载荷齐备;
  2. 用安装出来的 Host 完成首启 runtime 安装 + 全闭环(见
     evidence/v2-phase3/installed-app-e2e.txt);
  3. 重复安装到同一临时目录 → 同样 exit 0(不写用户既有「爪爪」登记项)。
- 未做:向 `%LOCALAPPDATA%\爪爪` 正式登记安装 + 控制面板卸载 + 卸载后
  `%LOCALAPPDATA%\爪爪-data` 保留断言。**原因是任务书要求现有安装目录只读**,
  正式登记会改写用户机器上的既有安装记录。
- 责任边界:用户机器的安装登记状态。
- 下一动作(用户批准后一条命令):
  `爪爪_0.1.0_x64-setup.exe /S` → 启动走闭环 → 控制面板卸载 →
  断言 `%LOCALAPPDATA%\爪爪-data\data\vk.db` 仍在。
- 状态:`deferred`(外部条件)。

## B3 · WebView2 窗口内的 UI 自动化(外部:工具链)

- 三次验证(2026-08-02):
  1. dev 真栈 Playwright 6/6(同一份 React/Node 代码);
  2. 安装态 API 层闭环 12/12(同一份 sidecar/DAG/SQLite);
  3. 打包窗口的 origin(`http://tauri.localhost`)已在 Rust 白名单内,与 dev 差异
     仅宿主。
- 未做:tauri-driver/WebDriver 通道内的窗口级自动化。
- 责任边界:tauri-driver 与 msedgedriver 版本匹配(外部工具链)。
- 下一动作:`cargo install tauri-driver` + 接 Playwright/WebdriverIO,复用
  `e2e/vk.spec.ts` 场景。
- 状态:`deferred`(外部条件)。

## B4 · media-asr 重型能力装入版本化 runtime(外部:磁盘/带宽授权)

- 三次验证:安装器 `--extra media-asr` 路径与 5GiB 预检已实现并单测覆盖;
  同款重栈曾按 HQ-10 批准装入 vk 开发 venv 并真跑 10/10 语料;缺件时能力状态
  如实呈 `missing_dependency`(UI 实录)。
- 责任边界:用户的磁盘与带宽(零计费)。
- 最小复现:
  `node scripts/install-vk-runtime.mjs --bundle src-tauri/resources/vk --home %LOCALAPPDATA%\爪爪-data --extra media-asr`
- 状态:`deferred`(外部条件)。

## 常备备忘

- 本目标全程**新增真实付费 0**(全部走确定性 stub / run cache / FTS)。
- vk 人工门(HUMAN-QUEUE HQ-01~08)属上游 M 线,不由本集成代办;UI 按
  machine_ready / partial 如实展示。
