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
| phase1 vk-shell-v1 契约冻结 | todo | - |
| phase2 持久化与幂等 | todo | - |
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
