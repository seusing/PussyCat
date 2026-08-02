# FINAL INVENTORY — 爪爪 × video-knowledge(任务书 v2 收口,2026-08-02)

本文件的每一项都等于实际产物,命令可复核。v1 收口清单被本文件取代
(v1 的历史结论保留在 PROGRESS「Log」与各 phase 证据里)。

## 1. 仓库端点(完整 HEAD)

| 仓库 | 分支 | 起点 | 代码 endpoint | HEAD |
|---|---|---|---|---|
| video-knowledge-m1-productization | integration/vk-shell-v1 | `db4bb40`(= integration/m1-productization) | `86878f5`(完整见 §7) | 见 §7 |
| opencli-app-clone | integration/vk-shell-v1 | `54ddac4`(= p1b0/policy-protocol-spec) | 同 HEAD | 见 §7 |

- 远端 push = 0;远端标签发布 = 0;原作者 remote 修改 = 0。
- vk 本地 tag `vk-shell-v1`(阶段1 冻结点)未移动。
- 范围 diff-check:`git diff --check <起点>..HEAD` 两仓均 **0**
  (v1 期间遗留的 347 处证据尾随空格已修正,旧 "clean" 结论在 PROGRESS 更正)。

## 2. 契约与 schema 版本

| 项 | 值 |
|---|---|
| `api_version` | **1.4.0**(1.0 冻结 → 1.1 幂等/历史 → 1.2 指纹 → 1.3 凭据边界 → 1.4 progress;全加法) |
| `processing_request_schema_version` | **1.1.0** |
| `preset_schema_version` / `capability_result_schema_version` | 1.0.0 / 1.0.0 |
| vk DB migrations | 001..**009**(007 budget-stop、008 shell_jobs、009 uploads;均成对 down) |

握手校验:`service` + `api_version`(major=1, minor≥1)+
`processing_request_schema_version`(major=1, minor≥1)三项齐过才启动,
任一不符 → `protocol-mismatch` 拒绝(两条版本篡改红测)。

## 3. 构件与哈希

| 构件 | SHA-256 |
|---|---|
| `video_knowledge-0.1.0-py3-none-any.whl`(源树 = endpoint `86878f5`) | `308b58d35dd7f3a1b8027b04f766d95d217c14fedaaea0f4fe4b57df56e6ffe7` |
| `uv.exe`(0.11.31,随包) | `f9984f1375c8…`(全值见 `src-tauri/resources/vk/runtime-manifest.json`) |
| `runtime-manifest.json` | 构建期生成;安装端实算 digest 比对 |
| NSIS / MSI | 见 §7(每次打包重算) |

SBOM:vk `docs/evidence/vk-shell-v1-sbom.cdx.json`(cyclonedx1.5,25 组件);
licenses:`vk-shell-v1-third-party-licenses.json`;凭据扫描 repo/wheel **0/0**;
wheel 内跨项目 import **0**(`vk-shell-v1-wheel-inventory.v1.json`)。

## 4. 实际路径

| 项 | 路径 |
|---|---|
| 打包形态数据根 | `%LOCALAPPDATA%\爪爪-data`(Rust 恒注入 `OPENCLI_HOST_VK_HOME`) |
| runtime | `<数据根>\runtime\versions\<version>` + `runtime\active.json`(原子指针) |
| 用户知识库 | `<数据根>\data`(含 `vk.db`);另有 `models/ cache/ temp/ node-state/` |
| 捆绑件(安装目录内) | `<安装目录>\vk\{wheel, uv.exe, runtime-manifest.json}` |
| 安装验证目录(本次) | `C:\Users\Lauseusing\AppData\Local\Temp\zz-install`(**用户既有安装 `%LOCALAPPDATA%\爪爪` 全程未读未写**) |
| 安装验证数据目录 | `C:\Users\Lauseusing\AppData\Local\Temp\zz-data` |

## 5. 测试与门(v2 收口)

| 门 | v2 起点 | v2 收口 |
|---|---|---|
| vk pytest | 1160 | **1178** passed, 6 skipped, 2 deselected |
| vk strict mypy | 86 | 86 files |
| vk ruff / uv lock / diff-check / 状态一致性门 | 过 | 过(门 PASS) |
| oc vitest | 627 | **637** |
| oc cargo | 20 | **20** |
| oc tsc / npm build / verify:host | 过 | 过 |
| Playwright | 5 | **6**(新增跨模块入口) |
| 真机门脚本 | 5 | **6**(新增安装态 E2E) |

红→绿日志:`evidence/v2-phase1/red-*.txt`、`v2-phase2/red-*.txt`、
`v2-phase4/red-*.txt`;判别性红测与作用域说明:`v2-phase5/adversarial-and-scope.md`。

## 6. 费用

- 本次目标全程**新增真实模型付费 0**:全部走确定性 stub provider、run cache
  与本地 FTS。真实语料门只读既有 M4 库(历史实付 ¥8.3279 原样浮出,零新增)。
- `max_cost_cny` 为后端强制上限:每次付费调用前按最坏情况预估,越界零发送终止。

## 7. 本次收口的实际值

| 项 | 值 |
|---|---|
| vk HEAD(完整) | `86fab43d2c3407065029f69d9198be275d091898` |
| vk 代码 endpoint | `86878f5a8041f8b9e37ed9ccb82043885c6622ec` |
| oc HEAD(完整,本文件所在提交的父) | `85ee3be42f4f0929e1e5b7905bd5b40fbbcaebc3` |
| wheel | `308b58d35dd7f3a1b8027b04f766d95d217c14fedaaea0f4fe4b57df56e6ffe7` |
| NSIS `爪爪_0.1.0_x64-setup.exe`(源码 `85ee3be`) | `d7f952beab5262f28a05a2372940741ce79b670e07efd9cbd55e052cbfc25062` |
| MSI `爪爪_0.1.0_x64_zh-CN.msi`(源码 `85ee3be`) | `fcc1b9676ec6675de6c921a33767c402f9af6a36c2ee1e52ad99acca641546d8` |

安装态验收(evidence/v2-phase3/installed-app-e2e.txt,**12/12**):
真 NSIS 安装 → 首启 not-installed → 捆绑 wheel+uv 安装 runtime(10s,60 行真实
日志)→ 提交 fixture → 真 DAG done(实付 0.005 stub 币)→ progress 九阶段真实投影 →
笔记产物 1030B → 引用查询 5 条 → 重启 Node+Python → 历史可看 → 同 key 同 job_id
零新增调用 → 历史 retry 保 parent 且 cache hit 零调用。

> 若 §7 与 git 不符,以 git 为准(本节由收口提交写入,oc HEAD 指其父提交)。
