# 阶段 6 · 七类反向失败注入 —— 证据映射(2026-08-01)

任务书要求「至少对协议版本、字段截断、预算越界、绝对路径泄露、幂等重复提交、
sidecar 崩溃、token 泄露各反向制造一次失败」。七类均已在红→绿电池中真实注入,
此处给出锚点(测试名 → 文件):

| # | 反向注入 | 注入方式 | 机器锁 |
|---|---|---|---|
| 1 | 协议版本不匹配 | stub meta 返回 api_version=2.0.0 / shell_mode=false | `rejects an incompatible api major with protocol-mismatch and kills the child`、`rejects a sidecar that did not enter shell mode`(server/vk-sidecar.test.mjs) |
| 2 | 字段截断/畸形载荷 | 完整 ProcessingRequest 改坏枚举(quality_profile=extreme)→ 400;schema 负载(0/-1/"3" 上限、v1.0.0 携带 cap)→ SchemaViolation | `test_post_preview_resolves_once_and_jobs_accepts_full_request`(vk tests/knowledge/test_web_shell_contract.py)、`test_request_schema_rejects_nonpositive_or_mistyped_cap`、`test_v100_payload_still_validates_but_cannot_carry_cap`(test_budget_guard.py) |
| 3 | 预算越界 | 上限 0.01/0.001 CNY,最坏情况预估在 transport 前触发终止,零发送零扣费 | `test_gateway_stops_before_transport_when_worst_case_exceeds_limit`、`test_run_ingest_stops_typed_and_persists_budget_stop`(test_budget_guard.py) |
| 4 | 绝对路径泄露 | 视图/错误文本注入本机绝对路径 → 折叠断言(全响应正则扫描) | `test_views_and_uploads_are_path_free_with_opaque_ids`、`test_error_messages_never_leak_absolute_paths`(test_web_shell_contract.py);`test_web_lists_and_serves_historical_runs_path_free`(test_web_persistence_contract.py);fixture E2E `job view carries zero absolute paths` |
| 5 | 幂等重复提交 | 同 idempotency_key 双发 → 同 job、执行体一次;E2E 层同 key 零新模型调用 | `test_idempotent_submit_returns_same_job_and_runs_once`(test_desktop_persistence.py)、`test_web_idempotency_key_returns_same_job`(test_web_persistence_contract.py)、fixture E2E `idempotent resubmit …` |
| 6 | sidecar 崩溃 | fake close(3) 带脏 stderr;真机 taskkill /T /F 强杀执行中 Python | `classifies a crash after readiness with scrubbed stderr tail`(vk-sidecar.test.mjs);kill 矩阵门 10/10(scripts/verify-vk-kill-matrix.mjs) |
| 7 | token 泄露 | stderr 注入真 token → 脱敏;health/ready 行/响应序列化扫描无 token;VK_UI_TOKEN 过短拒启 | `handshakes /api/meta … leak-free health projection`、`classifies a crash …`(vk-sidecar.test.mjs);`test_env_token_locks_every_route`(test_web_shell_contract.py);冻结锁 `gui ready line is frozen and token free`(vk test_shell_contract_freeze.py) |

另有超出清单的反向项:MAX_PATH 深路径装完即坏(阶段5 实测→预检拒)、坏 wheel
注入回滚(runtime-rollback 证据)、Origin 门(白名单外 403)、白名单外 /vk 路由
404 零转发、chapter 片尾越界被 vk 真校验隔离(fixture E2E 首跑实录)。
