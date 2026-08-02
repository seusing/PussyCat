# FINAL INVENTORY — 爪爪 × video-knowledge(任务书 v2 收口,2026-08-02)

本文件的每一项都等于实际产物,命令可复核。v1 收口清单被本文件取代
(v1 的历史结论保留在 PROGRESS「Log」与各 phase 证据里)。

## 1. 仓库端点(完整 HEAD)

| 仓库 | 分支 | 起点 | 代码 endpoint | HEAD |
|---|---|---|---|---|
| video-knowledge-m1-productization | integration/vk-shell-v1 | `db4bb40`(= integration/m1-productization) | `142ef2354ff10a6a72b7be5f4d54b3ec4b0f0e19` | 见 §7 |
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
| `video_knowledge-0.1.0-py3-none-any.whl`(源树 = endpoint `142ef23`) | `03e8bf6458ee7fb4789096fde26a85c469403d55d7dc83fe7fc10659410979b4` |
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
| vk pytest | 1160 | **1177** passed, 6 skipped, 2 deselected |
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

## 7. 本次收口的实际值(打包后回填)

- vk HEAD:见下方"回填"节。
- oc HEAD:见下方"回填"节。
- NSIS / MSI SHA-256:见下方"回填"节。

> 回填由收口提交完成;若本节仍为占位,说明收口提交未落地,以 git 为准。
