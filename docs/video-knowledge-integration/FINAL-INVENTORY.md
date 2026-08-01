# FINAL INVENTORY — 爪爪 × video-knowledge 集成(2026-08-01)

完成条件 4 的机器清单:以下每项等于实际产物(命令可复核)。

## 仓库端点

| 仓库 | 工作分支 | 起点(fork) | 收口 HEAD | 代码 endpoint |
|---|---|---|---|---|
| video-knowledge-m1-productization | integration/vk-shell-v1 | `db4bb40`(= integration/m1-productization) | `18da94a` | `380d56a`(docs-only 尾随,状态门 enforce) |
| opencli-app-clone | integration/vk-shell-v1 | `54ddac4`(= p1b0/policy-protocol-spec) | 见 git log(本文件所在提交) | 同 HEAD |

vk 本地 tag:`vk-shell-v1`(阶段 1 冻结点)。远端 push=0、远端标签发布=0、
原作者 remote 修改=0(vk upstream push 本就是 no_push://)。

## 契约版本

| 项 | 值 |
|---|---|
| api_version(vk-shell) | **1.2.0**(1.0.0 冻结 → 1.1.0 幂等/历史视图 → 1.2.0 指纹暴露;全加法,契约 §10) |
| processing_request_schema_version | **1.1.0**(1.0.0 兼容读,max_cost_cny 仅 1.1.0 可携带) |
| preset_schema_version | 1.0.0 |
| capability_result_schema_version | 1.0.0 |
| vk DB migrations | 001..**007**(007=budget stop 三列,成对 down) |

## 构件哈希

| 构件 | sha256 |
|---|---|
| `video_knowledge-0.1.0-py3-none-any.whl`(源树=endpoint 380d56a,构建于 d29229b) | `762649c05d9026de0fa24802591ac2e9a833977a33b3779e239dd3f31f4487ba` |
| `爪爪_0.1.0_x64-setup.exe`(NSIS,源码 d78eb39) | `dd4a490071ac4fcf63628c53a7efc98e974338fdd2f22b137c18622772fabafb` |
| `爪爪_0.1.0_x64_zh-CN.msi`(WiX,源码 d78eb39) | `f873a7d68e620c2c77b5ab2d6f2cde825fa7369b135acd1037e2b3a3b6216844` |

SBOM:vk `docs/evidence/vk-shell-v1-sbom.cdx.json`(cyclonedx1.5,25 组件);
licenses:`vk-shell-v1-third-party-licenses.json`(3 个诚实 UNKNOWN);
凭据扫描 repo/wheel = 0/0;跨项目 import(wheel)= 0
(`vk docs/evidence/vk-shell-v1-wheel-inventory.v1.json`)。

## 测试基线(全部 ≥ 任务书既知基线)

| 门 | 基线 | 收口 |
|---|---|---|
| vk pytest | 1123 passed | **1160 passed**, 6 skipped, 2 deselected(棘轮 1123→1134→1148→1152→1159→1160) |
| vk strict mypy | 85 files | 86 files |
| vk ruff / uv lock / diff --check / 状态一致性门 | 过 | 过(门 PASS) |
| oc vitest | 583 | **627**(56 文件) |
| oc cargo | 19 | **20** |
| oc tsc / npm build | 过 | 过 |
| Playwright(新增) | - | **5/5**(宽/窄/键盘/错误恢复/真栈闭环) |
| 真机门脚本(新增) | - | sidecar 冒烟 11/11、fixture E2E 16/16、kill 矩阵 10/10、真实语料 7/7、闭包门 9/9 |

## 真实闭环证明(费用)

- 零费 fixture E2E:上传→预检→费用确认→真 DAG done→产物→查询→幂等同任务→
  完整 cache hit(模型调用恰 2 次、cache 复跑 0 次、实付 0 真币)。
- 真实语料:10 条真实 run 台账重现(历史实付 ¥8.3279 原样浮出,本次 0 新增)、
  真笔记 10096 字节、真 FTS 查询 5 引用。
- 本目标全程新增真实模型付费:**0**(全部 stub/缓存/FTS)。
