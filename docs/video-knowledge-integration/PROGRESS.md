# PROGRESS — 爪爪 × video-knowledge 集成(vk-shell-v1)

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
| phase3 Node Host 集成 | todo | - |
| phase4 视频解析标签页 | todo | - |
| phase5 运行时与数据生命周期 | todo | - |
| phase6 测试与真实验收 | todo | - |

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
