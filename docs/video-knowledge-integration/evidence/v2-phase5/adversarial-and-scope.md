# v2 阶段5/6 · 判别性红测与作用域说明(2026-08-02)

## 每项的"先红后绿"锚点(v2 新增部分)

| v2 阶段 | 判别性红测(先制造失败) | 绿态 |
|---|---|---|
| 1 凭据边界 | `test_credential_boundary.py` 三测在实现前全红(preview 回显原 URL / 提交面哨兵 / sources.url 落库带 token) | 三测绿,vk 1160→1163 |
| 2 DB 幂等 | `test_shell_jobs_persistence.py` collection 即红(`IdempotencyConflict` 不存在);实现中被自己的红测抓出终态落库竞态(status 停在 running) | 10 测绿,vk →1177 |
| 3 安装 bootstrap | `vk-runtime-install.test.mjs` SHA 篡改/离线/超长路径三红;真机 manifest 篡改注入实测 `sha-mismatch` 且 active.json 不写 | 单测绿 + 真机绿 |
| 4 协议校验 | `vk-sidecar.test.mjs` 两条版本篡改红测(api major=2、schema major=2)→ 必须 protocol-mismatch | 15 测绿 |
| 4 真实进度 | `test_runtime_progress.py` 四测红(`progress` 键不存在) | 四测绿 |
| 5 跨模块入口 | Playwright 跨模块用例首跑连红三次:结果表未切页签 → 哨兵断言过宽(执行通道误判)→ 取错 job(跨用例串扰) | 6/6 绿 |

## 真机抓获的两个实现缺口(不是文档声明,是测试咬出来的)

1. **upload id 仅进程内存** → 安装态 E2E 的历史 retry 直接 failed。修:migration 009
   `uploads` 表持久映射(只存 data root 内相对 uri),retry 跨重启可解析。
2. **`register_upload` 的 `relative_to` 撞未归一化 root**(8.3 短名 vs resolve 后)
   → 上传 400。修:两侧 resolve,并补未归一化 root 的回归测试。

## 作用域与边界(诚实声明)

- **凭据边界的"执行通道"例外**:视频页的 source 输入框与 `POST /vk/v1/jobs` 的请求体
  按设计携带原始 URL(xsec_token 等对小红书取材是必需的)。脱敏管辖的是**回显、
  持久、日志、诊断与历史面**:preview 响应、job 视图、shell_jobs.public_request、
  requests/ 工件、sources.url、Node 影子。上述每一面都有哨兵扫描断言。
- **跨模块用例的注入点**:OpenCLI 命令的执行结果在**网络边界**(`/start` + `/events`)
  注入,与 LLM 用确定性 provider 同类;React/store/ResultsTable/VkPanel/Node vk 代理/
  sidecar/SQLite/DAG/产物读取全部生产实现。理由:该用例要验的是交接与解析闭环,
  不是 opencli 抓取本身(抓取正确性由 opencli 自身与 p1b0 线覆盖)。
- **公开平台 URL smoke**:未纳入自动门(依赖外网与站点可用性,会把确定性门变成
  flaky 网络门)。BLOCKED 有条目与最小复现命令。
