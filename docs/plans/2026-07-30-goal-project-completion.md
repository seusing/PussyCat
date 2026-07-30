# GOAL：opencli-app-clone 执行准入 —— 项目级完工路线（v2，2026-07-30 修订）

基线 `p1b0/policy-protocol-spec @ 5de0dc2`（未推送，32 commits ahead of main），36 files / 355 tests 全绿。

> **v2 修订说明**：v1 把竣工定义为「全目录 1278 条命令每一条都有显式处置、unknown 归零」。该口径已废除，理由见下。v1 的 P2-P7 阶段降级为「后续策略路线」，不再是竣工必要条件。

## 竣工的定义（v2）

> **打包后的 OpenCLI App Clone 支持四站点八条精确只读命令的可安装纵向闭环**：每条命令有完整、经人工审定的 Host 判决（ready / acknowledgement-required），Host 是准入唯一权威；前端展示可执行性、确认要求与浏览器桥接诊断；**其余全部 browser 命令继续 fail-closed（unknown 拒绝）**，不追求 1278 条 unknown=0。

试点命令（显式 membership，逐条审定，见 `docs/specs/2026-07-30-browser-cookie-read-pilot-review.md`）：

| 站点 | 命令 |
|---|---|
| xiaohongshu | `whoami`、`feed` |
| bilibili | `whoami`、`hot` |
| twitter | `whoami`、`timeline` |
| youtube | `whoami`、`subscriptions` |

### 为什么废除 v1 的「unknown=0」口径

1. **逐条审定不可扩展**：三条 local-direct 审定花了整个 Task 1；1278 条按此速率是数百个 Task。v1 自己已承认这点并寄望于「cohort 级裁决机制」（原 P3），但该机制是否收敛是未知数——把竣工绑在一个未验证的设计上，等于工期不可定义。
2. **906 条 browser 命令（71%）没有任何 tier 承接**，其「正确归宿是显式 deny」这一判断本身也需要逐 cohort 论证。fail-closed 的 unknown 已经提供了与显式 deny 等价的运行时安全边界（都拒绝执行），差别只在文档完备性，不值得绑定竣工。
3. **纵向闭环先于横向覆盖**：一条从「点击命令 → Host 判决 → 确认 → 执行 → 结果可读」全线打通、可安装分发的真实路径，比 1278 条纸面处置更接近产品完成。

## 试点的不变量（沿用 P1-B0 全套，逐条有效）

- Host 是准入唯一权威（I-P1）；前端不复制、不推导准入规则。
- fail-closed（I-P2）：试点 membership 之外的 browser 命令保持 `unknown/no-tier` 拒绝；**不批量开放 60 条 read+cookie，更不放开 write/ui/intercept/download/login**。
- `strategy` / `browser` / `access` 单字段不等同安全语义（spec §3.0）；试点 membership 是显式命令名单，tier 阈值查的是逐条人工审定的六轴 metadata。
- 显式 deny 优先（I-P3）、reviewShapeHash / decisionFingerprint 双哈希、`shell:false` 冻结契约（I-P6）全部保留。
- 不实现第二套 BrowserBridge/daemon：执行链复用 OpenCLI 既有 `node main.js <argv>`（daemon 由 opencli 自身管理）；健康诊断复用 daemon 的结构化 `/status` 接口。

## Parity backlog（记录在案，本 goal 不实现）

以下是「完整复刻 OpenCLI App」还缺的产品能力。**它们不属于竣工定义**，逐项按需另立 goal：

| 项 | 说明 |
|---|---|
| 设置中心 | 完整设置页（端口/profile/主题/语言等）；本 goal 只做精简的浏览器桥接状态展示 |
| 首次运行向导 | 引导安装 Chrome 扩展、连接 daemon、验证登录态 |
| 系统托盘 | 最小化到托盘、后台驻留、托盘菜单 |
| 自动更新 | Tauri updater 通道、版本检查与增量分发 |
| 运行归档 | 活动历史 / 结果归档 / 导出（原 P1-B0 Task 9 的活动历史随之移出，见 t7-t9 goal 文档修订） |
| 多 profile 管理 | opencli profile 的图形化管理（list/use/rename） |

## 后续策略路线（原 v1 P2-P7，降级为非竣工必要条件）

原阶段划分保留为路线参考，优先级与工期均不再承诺：

- **local-direct 清零**（原 P2，22 条 `metadata-missing`）——第一个可完整清空的 cohort，产出可复用审定作业流程。
- **cohort 级裁决机制**（原 P3，设计任务）——若做横向覆盖，先回答「一条 tier 规则能否覆盖整个 cohort、例外如何识别」。
- **legacy 276 条清零**（原 P4，L4 门 / policy model GA）——`legacyCount === 0` 仍是 policy model GA 的定义，但 GA ≠ 本项目竣工。
- **browser-public 41 条**（原 P5 / P1-B1b）。
- **三个专项切片**（原 P6：持久凭据 / secret-output / download 家族）。
- **剩余 browser + write 面**（原 P7）——多数应落显式 deny + 记录理由。

## 全目录实测分布（2026-07-30，opencli 1.8.6，保留作参考）

| cohort | 条数 | 现状 |
|---|---|---|
| read + public + direct（legacy 基线） | 276 | 🟡 骑在临时豁免上，L4 要求归零（GA 门，非竣工门） |
| read + local + direct | 25 | 3 条已审定，22 条 `metadata-missing` |
| read + public + browser | 41 | 无 tier |
| browser + cookie | 724 | **其中 8 条进入 browser-cookie-read-pilot**，其余保持 unknown |
| browser + ui | 182 | ⚪ 无 tier、无规划 |
| browser + intercept | 6 | ⚪ 无 tier、无规划 |
| write（全体，跨 cohort） | 339 | ⚪ 独立威胁模型，未启动 |

## 全局铁律（Task 1-6 实际栽过，逐阶段有效）

**R1 先实测再写「满足条件」** —— 栽 2 次。一条错误宽慰**覆盖了已有的正确预警**：写「这里没问题」比不写更危险。

**R2 新增的失败路径 / 序列化代码，单元测试够不着** —— 栽 2 次。凡只在 HTTP/IO/存储边界生效的代码，必须有该层测试。

**R3 不许拿被测对象自己的输出对照它自己** —— 栽 2 次。期望值要么写死字面量，要么来自上一步的真实响应体。

**R4 夹具全落在允许集内部 = 拒绝路径交付即死代码** —— 栽 1 次。写测试前先问「这分支要什么输入才能到？我手里有吗？」

**R5 语义变更时，危险的不是变红的测试，是继续变绿的** —— 栽 1 次。必须主动对既有绿灯用例施加「关掉被改语义」的变异，看谁本该红却没红。

**R6 名字必须跟着内容改** —— 测试名、函数名、**以及用户可见文案**。

**R7 不删既有断言，改写而非翻向** —— `expect(has(x)).toBe(false)` 在空集上同样成立。

**每条新守卫都要有一处能打红它、且只红它的变异。** 施加变异后先 grep/sed 确认真的落盘再跑 —— 正则没匹配上时，输出与真实通过长得一模一样。

## 竣工验收门（本 goal 的自动门全集）

```bash
npx tsc --noEmit && npx vitest run && npm run build && npm run check:legacy
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/verify-host-closure.mjs
node scripts/verify-parent-watch.mjs
npm run tauri build   # NSIS/MSI 产物生成即过，不做交互式安装
```

另有 CI（`.github/workflows/ci.yml`）在 push/PR 上跑前四门；`LEGACY_BASE_REF` 由可信 runner 计算 merge-base 灌入，不接受 PR 可控输入。

**自动门之外的人工边界**（自动化明确不做、不据此宣称已验证）：真实四站点命令运行、Chrome/扩展/profile 操作、MSI/NSIS 交互式安装、视觉与登录态人工验收。四站点真机闭环在完成上述人工验收前**不得宣称**。
