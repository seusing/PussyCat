# P1-B0 策略协议 + 1a 本地竖切 设计稿

- 日期：2026-07-26
- 基线：`main @ 43d789b`（含 P1-A.1 覆盖表种子 `98e02fd`/`af10a8f`）
- 上游规格：`docs/specs/2026-07-23-opencli-app-clone-p0-design.md`（P1 口径见其 §P1-A / P1-B）
- 并行但**不属本里程碑**：BrowserBridge spike（见 §11）

---

## 1. 目标、范围、非目标

### 1.1 目标

把执行准入从「一条派生表达式」升级为**逐命令的策略判决协议**，并用一条最小竖切证明这套机器能跑：

1. Host 侧产出逐命令 `PolicyDecision`，成为执行准入的**唯一权威**；
2. 未审定、指纹过期、新命令一律 **fail-closed**；
3. 前端不再「跑了才知道不行」，而是渲染 Host 给的判决；
4. 需要告知的命令走**确认协议**，确认可复查、可撤销、随分类漂移失效。

### 1.2 范围（P1-B0 + 1a）

- 策略元数据 schema、轴定义、准入算法、逐命令指纹；
- `/catalog` 原子 envelope、`/start` 确认校验、冻结的错误语义；
- preferences v2 迁移 + acknowledgement 管理 + 独立的活动历史；
- **三条代表命令**的端到端竖切（§9）。

### 1.3 非目标（本里程碑明确不做）

| 不做 | 归属 |
|---|---|
| 放开 `read/local` 全部 24 条 | 逐条审定后按 tier 进入，不整体开闸 |
| BrowserBridge 任何执行路径（41 条 browser-public 在内） | P1-B1b |
| daemon 生命周期 / B′ / 版本门 / PID 清零 | spike + P1-B1b，**不进本里程碑 DoD** |
| `state-get`、宽泛 settings reader | 输出敏感度由参数决定，待 secret-output 切片 |
| `xiaoyuzhou/*` 三条 | 读写持久凭据（`~/.opencli/xiaoyuzhou.json` 的 `access_token`/`refresh_token`，401 时刷新写回，见 `clis/xiaoyuzhou/auth.js:18,40,71,114`） |
| download / export / cookie-export 家族 | 固定共享临时目录 `%TEMP%\opencli-download`、时间戳可预测文件名、无 per-run 隔离；须专项治理 |
| `ui` / `intercept` 策略、`write`、`login` | 后续切片，各自独立威胁模型 |

---

## 2. 术语、信任边界、不变式

### 2.1 信任边界

```
┌─ 前端（WebView）────────────────────────────┐
│ 只渲染 Host 给的 PolicyDecision            │
│ 不复制、不重算任何准入规则                 │
└──────────────── HTTP/SSE ──────────────────┘
┌─ Host（Node 子进程）───────────────────────┐
│ **执行准入的唯一权威**                     │
│ catalog 派生 + 人工 metadata + 指纹 → 判决 │
└──────────────── spawn ─────────────────────┘
┌─ opencli（vendored，固定版）───────────────┐
│ 我们无法修改其内部行为，只能在调用前把关   │
└────────────────────────────────────────────┘
```

### 2.2 不变式（不可协商）

| # | 不变式 |
|---|---|
| **I-P1** | **Host 是执行准入的唯一权威。** 前端的置灰/提示只是**体验**，绕过前端不得获得任何额外执行能力。 |
| **I-P2** | **fail-closed。** metadata 缺失、指纹过期、catalog 新增命令 → `unknown` → 拒绝执行。**不存在「先放行、后补审定」。** |
| **I-P3** | **显式 deny 优先级最高**，压过任何派生结果与 metadata。 |
| **I-P4** | **snapshot 与 policy 原子同源。** `/catalog` 一次返回同一 revision 的两部分；不允许前端分别请求后自行配对。 |
| **I-P5** | **acknowledgement 是防误操作与防陈旧 UI 的协议，不是操作系统权限。** 它不提升也不降低任何实际权限，只证明「用户在**这个分类版本**下确认过」。 |
| **I-P6** | 沿用 P0-B 冻结契约：`spawn(shell:false)`、argv 全为服务端常量、`commandKey===argv[0]/[1]`、强制 `-f json`、回环 bind、精确 Origin。 |
| **I-P7** | 参数值永不落盘、永不进活动历史（沿用脱敏与不可重放铁律）。 |

---

## 3. `PolicyMetadata` 与轴定义

### 3.0 一条前提：`strategy` 不是任何一根安全轴

上游的 `strategy`（`public`/`cookie`/`ui`/`intercept`/`local`）是**复合调度标签**，实测反例：

- `xiaoyuzhou/episode` 是 `local`，却**走网络并消费本地持久凭据**；
- `trae-cn/setup` 是 `local`，是**纯静态文本输出**；
- `trae-cn/targets` 是 `local`，却**连接运行中的 CDP 端点**；
- `mercury/reimbursement-plan` 是 `local`，读的是**用户显式指定的资料**；
- `ui`/`intercept` 描述的是**交互方式**，与凭据来源无关。

> **裁决：`strategy` 只作 candidate hint，不直接映射任何正交安全轴。**
> 早前「strategy × browser 零例外」的测量成立，但它证明的是**两个字段彼此自洽**，不是 `strategy` 语义等于 transport。字段自洽 ≠ 字段是我们以为的那个意思。

### 3.1 六根轴

```ts
export type PolicyMetadata = {
  executionPath: 'direct-node' | 'browser-bridge'
  authority:
    | 'public-network'        // 只访问公开网络资源
    | 'explicit-local-input'  // 用户在本次调用中显式指定的资料
    | 'ambient-local-files'   // 主动扫描固定用户目录/配置
    | 'live-local-app'        // 连接运行中的本地应用（CDP 等）
    | 'browser-profile'       // 动用具浏览器控制能力的 profile
  exposure: 'public' | 'personal' | 'secret' | 'unknown'
  effect: 'none' | 'local-file-write' | 'remote-write'
  credentialFlow: 'none' | 'consume' | 'produce' | 'both'
  residue: 'none' | 'temp-file' | 'persistent-session' | 'unknown'
}
```

### 3.2 派生 vs 人工（实测后的诚实划分）

| 轴 | 来源 | 人工面 |
|---|---|---|
| `executionPath` | **可派生**：`browser === true → browser-bridge`，否则 `direct-node`。实测 1278 条零例外 | 0 |
| `authority` | **人工**。无字段可派生（`strategy` 已证不可用） | 逐命令 |
| `exposure` | **人工**。`columns` 是表格视图不是返回体清单——`paperreview/review` 的 `columns` 无 `token`，返回体却含 `token` 且 `review_url` 内嵌它 | 逐命令 |
| `effect` | `access` 作 **candidate hint**，人工定案 | 见下 |
| `credentialFlow` | **人工**。参数名正则只产出 `sensitiveNameHint`，误报实证：`homebrew/cask --token` 的 token 是 Homebrew 包标识符 | 逐命令 |
| `residue` | `siteSession==='persistent'` 作 hint（实测 284/284 皆 browser），但**它的缺席证明不了无残留**（下载文件、临时凭据、本地配置都不在其射程） | 逐命令 |

**关于 `effect` 的人工面规模——不给上界。** 关键词扫描得到 51 个候选，其中 31 条有源码写入证据、20 条为名称误报（`destination`/`direction` 等）；扫描既会误报也会漏掉语义隐藏的写入。**启发式只生成候选集，不构成上界。**

### 3.3 `sensitiveNameHint`

```ts
sensitiveNameHint: boolean   // 参数名命中 /password|passcode|secret|token|cookie/i
```

**只作审定时的提示，不参与任何判决。** 全目录仅 6 条命中，其中至少 1 条确认为误报。

---

## 4. candidate tier 与准入算法

### 4.1 tier

tier 是**候选分组**，不是放行凭据。进入 tier 只说明「这批命令值得被审定」。

| tier | 定义 | 本里程碑 |
|---|---|---|
| `local-direct` | `executionPath==='direct-node'` 且 `strategy==='local'` | §9 三条进入 |
| `public-direct` | `executionPath==='direct-node'` 且 `strategy==='public'` | 现状 277−1 条维持，不重新审定 |
| `browser-public` | `executionPath==='browser-bridge'` 且 `strategy==='public'` | P1-B1b |
| 其余 | — | 不设 tier |

### 4.1.1 `local-direct` 的允许集（tier 阈值）

超出允许集的命令判 `denied`（`reasonCode=tier-threshold`），**不是** `unknown`——区别在于：`unknown` 是「还没审」，`denied` 是「审过了，这个 tier 不收」。

| 轴 | `local-direct` 允许值 | 被挡在外的实例 |
|---|---|---|
| `authority` | `public-network`、`explicit-local-input`、`ambient-local-files` | `live-local-app`（`trae-cn/targets` 连 CDP）、`browser-profile` |
| `exposure` | `public`、`personal` | `secret`（含 `state-get` 一类由参数决定输出的） |
| `effect` | `none` | `local-file-write`（download 家族）、`remote-write` |
| `credentialFlow` | `none` | `consume`/`produce`/`both`（`xiaoyuzhou/*` 三条） |
| `residue` | `none` | `temp-file`、`persistent-session` |

`public-direct` 与 `browser-public` 的允许集不在本里程碑定义（前者维持既有派生结果不重审，后者属 P1-B1b）。

### 4.2 准入算法（顺序即语义）

```
1. 显式 deny（COMMAND_POLICY_OVERRIDES）        → denied          [I-P3]
2. catalog 里不存在该命令                       → 不产出 decision
3. 落入某个已启用 tier?          否 → unknown（reasonCode=no-tier）
4. metadata 完整?                否 → unknown（reasonCode=metadata-missing）
5. metadata.reviewRevision 匹配当前 schema?  否 → unknown（reasonCode=review-stale）
6. tier 阈值：exposure/authority/effect/credentialFlow 是否在该 tier 允许集内?
                                 否 → denied（reasonCode=tier-threshold）
7. exposure==='unknown' 或 residue==='unknown' → unknown
8. authority === 'explicit-local-input'         → ready
       （表单本身已明示读取对象，选择动作即本次授权；再弹一次是纯噪声）
9. authority === 'ambient-local-files' 或 exposure === 'personal'
                                 → acknowledgement-required
10. 其余                                         → ready
```

**第 8 步必须排在第 9 步之前。** `mercury/reimbursement-plan` 正是 `explicit-local-input` + `personal`：两步顺序颠倒就会给它挂上一个与 §7.1 相矛盾的确认弹窗。这条顺序是语义，不是风格。

**P0-B 的三条件派生规则保留在 `public-direct` tier 内部**，本里程碑不改动其结果集（除已有的 `paperreview/review` deny）。**不新增任何自动放行路径。**

---

## 5. 指纹、catalog 漂移与 `unknown`

### 5.1 逐命令指纹（不是全 catalog 哈希）

全 catalog 哈希会让任意无关命令的漂移作废**全部**确认。指纹必须逐命令：

```
policyFingerprint = sha256(canonicalJson({
  policySchemaVersion,
  commandKey,
  catalogFields: { access, strategy, browser, siteSession,
                   args: [{ name, type, required, positional }] },   // 顺序归一
  metadata: { executionPath, authority, exposure, effect, credentialFlow, residue },
  metadataReviewRevision,
  denyRevision,
}))
```

**刻意排除**：`description`、`help`、`example`、`columns` 等展示性字段——它们变化不改变安全语义，不应触发重新确认。

**刻意包含 `args` 的结构**：可选参数变必填、新增参数、类型变化都可能改变命令的实际作用面。

### 5.2 漂移闸

| 事件 | 结果 |
|---|---|
| catalog 新增命令 | 无 metadata → `unknown` → fail-closed |
| 相关字段变化 | 指纹变 → 既有确认失效 → 重新确认 |
| metadata 修订 | `metadataReviewRevision` 变 → 指纹变 |
| overlay 出现 catalog 里不存在的 key | CI 门变红（P1-A.1 已建） |
| 展示性字段变化 | **不触发**任何重确认 |

---

## 6. Wire contract（冻结）

### 6.1 `PolicyDecision`

```ts
type PolicyDecision = {
  commandKey: string
  state: 'ready' | 'acknowledgement-required' | 'denied' | 'unknown'
  fingerprint: string
  reasonCode?: string          // 稳定标识，业务逻辑只认它
  reason?: string              // 自然语言，仅供展示
  metadata: PolicyMetadata     // 有效值（含派生结果）
}
```

`reasonCode` 稳定集合：`explicit-deny` / `no-tier` / `metadata-missing` / `review-stale` / `tier-threshold` / `exposure-unknown` / `residue-unknown`。

### 6.2 `/catalog` 原子 envelope

```ts
{
  snapshot: CatalogSnapshot,
  policy: {
    schemaVersion: number,
    generatedAt: number,
    decisions: PolicyDecision[],
  }
}
```

CatalogService 已经原子替换 `{snapshot, policy}`（P0-C 块 B 建立），响应必须一次返回**同一 revision** 的两部分 [I-P4]。

**降级语义**：Host 不在线时真实执行本身不成立。UI 可用本地 snapshot 展示目录，但所有命令一律显示 `unknown`（`reasonCode=host-offline`），不得沿用上次的 `ready`。

### 6.3 `/start`

```ts
{ runId, commandKey, argv, acknowledgement?: { fingerprint: string } }
```

冻结错误语义：

| 码 | 含义 |
|---|---|
| `400` | 请求结构错误（沿用现状） |
| `403` | `denied`（沿用现状 summary，deny 理由进 detail——P1-A.1 已建） |
| **`428`** | `acknowledgement-required` 但请求未带确认 |
| **`409`** | 请求带的 fingerprint 与当前判决不符 → 前端须重新拉 `/catalog` 再试 |

`428`/`409` 是新增码；`400`/`403` 语义不变，**不破坏 P0-B 冻结契约**。

---

## 7. Acknowledgement UX 与 Host 校验

### 7.1 口径

| 类别 | 粒度 |
|---|---|
| `ambient-local-files` + `personal` | **每命令首次确认**，绑定逐命令 fingerprint，可复查可撤销 |
| fingerprint 变化 | 重新确认 |
| `explicit-local-input` | 表单**清晰展示读取对象**；用户的选择动作即本次授权，不额外弹窗 |
| secret-capable reader / write / login | 后续切片逐次确认或专项治理，**本里程碑不涉及** |

**为什么不每次都确认**：这些是只读、无副作用、本机单用户场景。每次弹窗会训练出无脑点确认，**把后面 write/login 真正需要逐次确认时的信号强度提前磨钝**——确认疲劳会削弱最重要的那道闸。

### 7.2 Host 校验

前端的确认只是**采集**；判决在 Host：

```
/start 收到 acknowledgement.fingerprint
  → 与当前 decision.fingerprint 比对
  → 不符 → 409
  → 缺失但 state==='acknowledgement-required' → 428
```

**Host 不信任前端对 state 的判断** [I-P1]。

---

## 8. preferences v2 迁移与活动历史

### 8.1 迁移

现状：`PREFS_KEY = 'opencli-app:prefs:v1'`，`PreferencesSnapshot` 为严格 v1 schema。

```
v1 → v2
  保留：favoriteSites / favoriteCommands / recent（语义与容量不变）
  新增：acknowledgements: Array<{ commandKey, fingerprint, acknowledgedAt }>
  损坏记录**逐项丢弃**，不清空整份偏好（沿用块 A 复审确立的「坏项丢弃、好项保留」）
  无 v1 数据 → 直接建 v2
```

### 8.2 活动历史（**不叫审计**）

localStorage 不防篡改，叫「审计」是名不副实。

```ts
type ActivityEntry = {
  at: number
  commandKey: string
  decisionState: PolicyDecision['state']
  exposure: PolicyMetadata['exposure']
  acknowledged: boolean
  outcome: 'success' | 'failed' | 'cancelled' | 'rejected'
}
```

- **独立存储**，不塞进 preferences；
- 固定容量、可一键清空；
- **不记参数值、不记结果、不记错误详情** [I-P7]。

---

## 9. 三命令竖切与失败流程

### 9.1 三条代表命令（钉死，不在计划阶段重议）

| 类别 | 命令 | 实测形态 | 证明什么 |
|---|---|---|---|
| public/static | `trae-cn/setup` | `read/local`，**零参数**，输出本地 setup 说明 | `ready` 路径，无确认 |
| explicit-local-input | `mercury/reimbursement-plan` | `read/local`，7 参 5 必填（receipt/amount/date/merchant/notes），desc 明写 "without opening a browser" | 显式输入 + `personal` 输出，选择即授权 |
| ambient-local | `antigravity/recent-paths` | `read/local`，读 `history.recentlyOpenedPathsList` | 首次确认 → 持久化 → 撤销 → 指纹过期重确认 |

metadata 审定（本 spec 即为审定记录）：

| 命令 | executionPath | authority | exposure | effect | credentialFlow | residue |
|---|---|---|---|---|---|---|
| `trae-cn/setup` | direct-node | public-network | public | none | none | none |
| `mercury/reimbursement-plan` | direct-node | explicit-local-input | personal | none | none | none |
| `antigravity/recent-paths` | direct-node | ambient-local-files | personal | none | none | none |

### 9.2 真机门的替换准则（**现在就定，不留到验收日**）

实测：本机 **Antigravity 未安装**、**Trae SOLO 未安装**，Trae CN 已安装但其 `read/local` 命令只有 `setup`（静态）与 `targets`（`live-local-app`，不属本切片）。

> **本机今天没有任何可用的 `ambient-local-files` 命令。**

因此：

1. **自动化测试**一律使用合成 catalog + spawn fixture，**不依赖任何本机软件**——这是自动门的硬要求，不是退路；
2. **真机门**按以下顺序取第一个可用者：`antigravity/recent-paths` → `trae-solo/recent-workspaces` → `trae-solo/workspaces-list`；
3. 若三者皆不可用，真机门**记为「环境不具备，未验」并写进验收报告**，不得以自动测试代替，也不得因此判该项通过。

### 9.3 失败流程

| 场景 | 期望 |
|---|---|
| 命令 `unknown` | 前端置灰 + 就地说明 `reasonCode`；点不动，不发请求 |
| `acknowledgement-required` 未确认就绕过前端直发 | Host 返 `428` |
| 确认后分类漂移再运行 | Host 返 `409`，前端自动重拉 `/catalog` 并提示重新确认 |
| Host 离线 | 全部命令 `unknown`（`host-offline`），目录仍可浏览 |
| 撤销确认后再运行 | 回到 `acknowledgement-required` |

---

## 10. 测试矩阵与验收门

### 10.1 自动门（全部不依赖本机软件与网络）

| # | 断言 | 变异验证 |
|---|---|---|
| 1 | 新增命令无 metadata → `unknown`，且 `/start` 被拒 | 去掉 fail-closed 分支 → 红 |
| 2 | metadata 完整但 `exposure==='unknown'` → `unknown` | — |
| 3 | 显式 deny 压过一切（含 metadata 完整且满足 tier） | 调换算法顺序 → 红 |
| 4 | 指纹**逐命令**：改动 A 命令的 args 不使 B 的确认失效 | 改成全 catalog 哈希 → 红 |
| 5 | 展示性字段（description）变化**不**触发重确认 | 把 description 纳入指纹 → 红 |
| 6 | `acknowledgement-required` 无确认 → `428`；错 fingerprint → `409` | — |
| 7 | `/catalog` 的 snapshot 与 decisions 同 revision | — |
| 8 | preferences v1 → v2 迁移保留收藏与 recent；坏项逐项丢弃 | — |
| 9 | 活动历史不含参数值/结果/错误详情 | 写入参数 → 红 |
| 10 | 前端不含任何准入规则副本（源码级断言：`src/` 内无派生表达式） | — |

### 10.2 真机门

1. 三条代表命令各跑一遍（ambient 一条按 §9.2 替换准则）；
2. 首次确认 → 完全退出 → 重开 → 确认仍在；
3. 撤销 → 再运行 → 回到需确认；
4. 人为改 metadata revision → 既有确认失效、要求重确认。

### 10.3 DoD

**BrowserBridge 的任何结论都不进本里程碑 DoD。** spike 未完成不阻塞 P1-B0+1a 交付。

---

## 11. 残余风险与 spike 链接

| 风险 | 处置 |
|---|---|
| `effect` 人工面规模未知 | 已明确不给上界；tier 逐步开放，未审定即 `unknown` |
| localStorage 可被用户/其他脚本改写 | 已改称「活动历史」；acknowledgement 被伪造只影响提示，**不提升执行权限**（Host 仍按 decision 判决）[I-P5] |
| 前端置灰与 Host 判决短暂不一致 | 靠 `409` 兜底；前端置灰只是体验 [I-P1] |
| 本机缺 ambient-local 软件 | §9.2 替换准则；不具备则记「未验」，不粉饰 |
| BrowserBridge 外部前提（Chrome 扩展需用户自装、daemon TOCTOU、B′ 清理承诺） | **链接**至 BrowserBridge spike brief，不在本里程碑内裁决 |
| vendored opencli 内部行为不可控（异版本 daemon 会被它主动替换） | spike 结论 + P1-B1b 的 Host 侧前置门 |

---

## 12. 待确认

无。本稿的所有取舍均已在设计讨论中裁决；三条代表命令的 metadata 审定见 §9.1，替换准则见 §9.2。
