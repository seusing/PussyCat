# PROGRESS — 爪爪 × video-knowledge 集成(vk-shell-v1)

## 任务书 v2 开工回执(2026-08-01)

1. v2 目标源:goal.txt(安装态产品闭环);Phase 1–4 只回归不重写。
2. 阶段0 复核:vk HEAD 18da94a、oc HEAD c57e6f0 与任务书一致;两树 clean。
3. 任务书指出的范围 diff-check 属实(oc 54ddac4..HEAD 347 处证据尾随空格),
   已修复并把旧 "clean" 结论在此更正;现两仓范围 diff-check 均为 0。
4. v2 基线复跑全绿:vk 1160/ruff/mypy86/lock + wheel 重建 sha 逐字节复现
   762649c0… + 干净 venv import smoke;oc tsc/vitest 627/build/cargo 20/
   Playwright 5/5(evidence/v2-phase0/)。
5. 顺序执行 §三 0–6;同门三连败即记录转下一项;新增真实付费默认 0。

任务书:用户 goal.txt(2026-08-01 下发)。**断线重连后:先读本文件,再读 BLOCKED.md;
已验收阶段只做回归,不重做。** 基线事实见 BASELINE.json,证据在 evidence/。

## 固定事实

- 两仓工作分支均为 `integration/vk-shell-v1`:
  - video-knowledge:fork 自 `integration/m1-productization@db4bb40`(clean)
  - opencli-app-clone:fork 自 `p1b0/policy-protocol-spec@54ddac4`(clean)
- 架构冻结(任务书拍板 1–8):React → **Node Host(唯一 sidecar 管理器)** → vk Python
  sidecar;Rust 只管既有 Node Host 进程树;React 只访问 Node 的 `/vk/v1/*` 代理,
  永不直连 Python、永不接触 sidecar token;Python 自带 Web UI 保留为独立诊断入口
  (爪爪不嵌 iframe)。
- MVP 入口:直接 URL + 单条 OpenCLI 采集结果"送去视频解析"。批量 Manifest UI、
  SSE/WebSocket、通用插件框架后置。
- 默认 1 个重任务 active,其余 queued;进度只显示真实 stage/elapsed/actual cost,
  不造百分比。
- `max_cost_cny` 为后端强制费用上限(每次付费调用前按最坏情况预估执行);
  `budget_profile` 继续表示路由档位。
- 知识库分目录:app / runtime / models / data / cache / temp;卸载默认保留 data。
- M3/M4 能力状态按证据如实展示 machine_ready / partial;人工门未闭合不得标 verified。

## 与 2026-07-31 既有文档的关系

`docs/specs/2026-07-31-video-knowledge-integration-contract.md` 与
`docs/plans/2026-07-31-video-knowledge-integration-plan.md` 仍是有效输入(事实调查、
风险清单、费用确认拍板继续沿用);**冲突处以 goal.txt 拍板为准**。已识别的唯一实质
冲突:plan §3 设想 Rust 直接监管 vk sidecar → 改为 Node Host 唯一管理(拍板 1)。
plan 的 P-int-0..3 阶段划分被本任务书的阶段 1–6 取代。

## Stage ledger

状态:complete | partial | in_flight | todo | blocked。

| Stage | Status | Evidence |
| --- | --- | --- |
| task0 事实基线 | complete | BASELINE.json + evidence/task0/ + vk@6abd39e |
| phase1 vk-shell-v1 契约冻结 | complete | evidence/phase1/ + vk 契约 docs/SHELL-INTEGRATION-CONTRACT.md + 本地 tag vk-shell-v1（endpoint 0f784c3） |
| phase2 持久化与幂等 | complete | evidence/phase2/ + vk docs/evidence/vk-shell-v1-phase2-persistence.v1.json（endpoint c59e778,api 1.1.0）。Node 脱敏影子→phase3 落地;三层 kill 矩阵→phase6 验收 |
| phase3 Node Host 集成 | complete | evidence/phase3/(红/绿/真机冒烟 11 项)+ 本仓 3958bfd/cda6365/cb52f11 + vk api 1.2.0(endpoint 380d56a) |
| phase4 视频解析标签页 | complete | evidence/phase4/(绿门+浏览器真机六项实录)+ 本仓 5e8d109/a488fe1/54dfc89 |
| phase5 运行时与数据生命周期 | complete(机器侧) | evidence/phase5/ + 本仓 071de7b/ff84f62 + vk@18da94a(wheel 762649c0…,SBOM 25 组件,凭据 0/0,跨项目 import 0)。遗留归 phase6:安装包捆 wheel+uv、media-asr 真装入 runtime、卸载真机验证 |
| phase6 测试与真实验收 | complete(机器侧;外部项见 BLOCKED B1–B5) | evidence/phase6/(fixture E2E 16/16、kill 矩阵 10/10、Playwright 5/5、真实语料 7/7、安装载荷 E2E、七类反向映射、安装包哈希)+ FINAL-INVENTORY.md |

## Log

- 2026-08-01 task0 完成:
  - 两仓 git 事实实测(HEAD/branch/remote/tags/worktrees 与既知基线一致);
    七项验证全绿且数字逐项吻合(vk 1123/6/2 + mypy 85 + ruff + lock;
    oc vitest 583 + cargo 19 + build),完整输出在 evidence/task0/。
  - 发现并修复 vk 事实漂移:状态一致性门 FAIL(endpoint d83aa7b 落后于含
    tools/ 脚本的 db4bb40)→ endpoint 重锚 db4bb40;M4-ACCEPTANCE.md 补
    superseded 横幅(正文原样保留)。门重跑 PASS 8/8。vk 提交 `6abd39e`。
  - 专用分支 `integration/vk-shell-v1` 两仓建立,起点 clean。
- 2026-08-01 phase1 完成(vk 仓 8 commits,db4bb40→30e9ab1,tag `vk-shell-v1`):
  - **契约冻结**:`docs/SHELL-INTEGRATION-CONTRACT.md`——/api/meta 握手(api 1.0.0/
    schema 1.1.0/包版本/环境级能力五态)、GET /api/jobs 列表、POST preview/jobs 接受
    完整 ProcessingRequest 并 schema 校验(默认值只在 vk 解析一次)、retry+refresh
    均复用同一请求对象且带 parent_job_id(refresh 显式绕过来源版本缓存)、
    VK_UI_TOKEN shell 模式全路由认证、opaque out_/up_ id、响应与错误文本零绝对路径。
  - **max_cost_cny 硬上限**:中央模型调用边界每次 transport 前按最坏情况预估,
    越界零发送终止;typed reason/actual/limit 落 pipeline_runs(migration 007)+
    IngestReport.budget_stop + 视图;CLI 退出码 6。指纹画布冻结在 1.0.0 投影,
    既有语料 run cache 逐字节存活(oracle 测试为证)。
  - **红→绿**:红证据 evidence/phase1/red-*.txt;绿收口 1152 passed/6 skipped/
    2 deselected(棘轮 1123→1134→1148→1152)+ ruff/mypy 86/lock/diff 全过
    (evidence/phase1/green-vk-phase1-gates.txt);vk 状态一致性门 PASS 8/8。
  - **两个载荷级发现**:gui ready 行管道下被块缓冲(Node spawn 场景握手必死)→
    flush 入契约;存量 queued-cancel 竞态(原码 8 跑 4 挂)→ 确定性化且断言加强。
- 2026-08-01 phase2 完成(vk 4 commits,endpoint c59e778,api 1.1.0,门 PASS 8/8,
  棘轮 1152→1159):
  - vk.db 为 run/stage/artifact/cost 真源:`GET /api/jobs` 合并 live 与历史
    `run:<run_id>` 行(去重);`run:` 视图从 DB 重建 note/product/audit 产物
    (相对 uri→opaque id,零绝对路径)。
  - 重启 reconcile:孤儿 running→interrupted,只翻状态**绝不自动重跑**——重启
    本身零新增扣费;显式 retry/refresh 才是新执行决策且受 max_cost_cny 管辖。
  - 幂等:相同 idempotency_key 重复提交返回同一 job 且执行体只跑一次;跨重启
    执行级幂等由 run cache 承担(零下载零模型调用的机器锁既有)。
  - 契约 1.1.0 加法升版(版本历史入契约 §10);Node 侧只存脱敏四元组的规则
    写入契约 §7(实现落 phase3);三层 kill 矩阵排入 phase6。
- 2026-08-01 phase3 完成(本仓 3 commits;vitest 583→606、cargo 19 红→绿、
  verify:host 9/9、真机冒烟 11/11):
  - **VkSidecarManager**(独立类,不复用 RunManager 90 秒语义):随机 loopback
    端口 + VK_UI_TOKEN 环境注入 + ready 行握手 + /api/meta 版本兼容检查
    (major=1/minor≥1/shell_mode 必真)+ 按需单飞拉起;四类可操作诊断
    (not-configured/runtime-missing/spawn-timeout/protocol-mismatch)+ 崩溃
    sidecar-exited 带脱敏 stderr 尾;首诊不被 close 覆盖。
  - **/vk/v1/\* 白名单代理**:注入认证、Origin 门管辖、白名单外 404 零转发、
    typed 503、uploads 8MiB 原始通道、client_job_id 转发前剥离;
    /vk/v1/health 为 Node 投影(零 pid/port/token/路径)。
  - **脱敏影子**(I-P7 逐字段重建):仅持久化 clientJobId/idempotencyKey/
    requestFingerprint/runId/displayStatus(+updatedAt),vkJobId 仅内存;
    vk 视图新增 request_fingerprint(契约 1.2.0)供影子取数。
  - **Rust 配置面收口**:4 个 OPENCLI_HOST_VK_* 入 HOST_ENV_KEYS 且
    configure_host_env 显式移除(VK_PYTHON 是 spawn 向量;打包形态阶段5
    由 supervisor 显式设值);cargo env 面扫描测试红→绿。
  - **真机双进程闭环**:真 Node spawn 真 Python 487ms ready、preview 全链路、
    优雅关停零孤儿(scripts/verify-vk-sidecar.mjs,11/11)。
- 2026-08-01 phase4 完成(本仓 3 commits;vitest 606→627、tsc 零错、build ✓、
  浏览器真机六项实录):
  - **「视频解析」第三标签页**:健康条(api 版本+环境能力真实状态,
    missing_dependency 如实展示)、全字段提交表单、预检显示引擎解析投影+
    输出目标+区间估算(M0 实测为据,缺样本 unknown+原因)、**费用确认对话框**
    (拍板 5.5:每次都弹、估算不是承诺、不存储)、任务列表与详情(真实状态/
    已耗时/实际费用,零推测百分比;budget_stop 横幅;证据覆盖;产物下载;
    cancel/retry/强制重跑)、会话诊断、知识库查询(带引用)。
  - **「送去视频解析」**:采集结果行 URL 嗅探,store 只交接规范化 URL+脱敏
    provenance(commandKey/collectedAt),零行数据、零第二种 manifest。
  - **真实缺陷修复**:run:<id> 的冒号被 encodeURIComponent 编码致真实链路
    404——改保留冒号的 path 编码(测试红→绿抓获)。
  - 浏览器真机:真 vite+真 Node+真 Python——标签切换、api 1.2.0 握手、
    全链路预检(引擎解析默认值)、费用对话框弹出与取消,逐项实录入证据。
- 2026-08-01 phase5 完成(机器侧;vitest 627 不动、cargo 19→20):
  - **固定 SHA wheel**(vk@18da94a):video_knowledge-0.1.0 sha256
    762649c0…,uv 原生 cyclonedx1.5 SBOM(25 组件)+ 第三方 licenses
    (3 个诚实 UNKNOWN)+ 既有 inventory 工具全跑(凭据扫描 repo/wheel 0/0、
    跨项目 import 0)。
  - **版本化独立 runtime**:uv 独立 CPython venv、四道 smoke(import/console/
    真 gui API 握手 1.2.0/临时库迁移 001..007)全绿才 active.json 原子切换;
    坏 wheel 注入实证 FAIL 后 active 稳在旧版;真实 vk.db 迁移前备份、
    失败自动还原。**MAX_PATH 实测坑**:深路径下 uv(\\?\)写得进、Python
    io.open 读不出→装完即坏,已加 home>100 字符预检拒绝。
  - **数据生命周期**:report/verify(integrity+悬空,经 active runtime 零新
    依赖)/export/clean(dry-run 默认)/purge 全流程真跑;purge 后 db_exists=
    false、仅 runtime 存留。
  - **Rust 打包态**:configure_host_env 只信 %LOCALAPPDATA%\爪爪-data\runtime\
    active.json(fail-closed 单测),数据根与安装目录分离=卸载默认保留知识库。
  - 归 phase6:安装包捆 wheel+uv 与安装时装 runtime、media-asr 真装
    (最小复现:`node scripts/install-vk-runtime.mjs --wheel <whl> --home %LOCALAPPDATA%\爪爪-data --extra media-asr`,
    预检 5GiB)、卸载/保留真机矩阵。
- 2026-08-01 phase6 完成(机器侧;剩余外部项 BLOCKED B1–B5 各附三点验证+
  责任边界+下一动作):
  - **零费 fixture E2E 16/16**:本机 LLM stub + 真三层栈完整闭环——上传→预检→
    费用确认→真 DAG done(恰 2 次模型调用)→产物/证据覆盖/查询 5 引用→幂等
    同任务→完整 cache hit(0 费 0 调用)→零孤儿。vk 真校验还当场咬出 stub
    章节片尾越界(quarantined),修正后绿——校验门是活的。
  - **sidecar kill 矩阵 10/10**:执行中强杀→sidecar-exited 类型化诊断→懒重拉
    +reconcile interrupted→重启零自动扣费(调用计数冻结)→旧 upload id 按
    进程生命周期契约 404→重传重提交 done(+2 次=新决策)→SQLite ok→零孤儿。
  - **Playwright 5/5**(chromium,真 vite node 模式+真 Host 43199+真 sidecar):
    宽/窄/键盘/错误恢复(坏 upload 源在提交边界类型化报错后修正恢复)/
    UI 闭环(预检→费用对话框→确认→已完成行(实际费用)→详情→笔记→查询引用)。
  - **真实语料 7/7(零新费用)**:sidecar 指向仓外 M4 真库(先备份
    vk.db.backup-vk-shell-verify-*,boot 迁移把真库前移 001..007、integrity ok)
    ——10 条真实 run 台账重现(历史实付 ¥8.3279 原样)、真笔记 10096B 经
    opaque id 下载、"帕鲁" 真 FTS 查询 5 引用、零绝对路径。
  - **安装包**:npm run package 全门后产 NSIS+MSI(哈希入册);msiexec /a
    零登记抽取→vk 载荷四件在包→抽出 exe 真启动拉起 Node 子进程→收树零孤儿;
    用户现有安装目录全程未读未写。
  - **七类反向注入映射**:协议版本/字段截断/预算越界/路径泄露/幂等/崩溃/
    token 泄露 → 逐条锚到红→绿测试(adversarial-negative-map.md)。
