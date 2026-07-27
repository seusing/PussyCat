# P1-B0 策略协议 + 1a 本地竖切 设计稿

- 日期：2026-07-26（v2，吸收第一轮评审 6 组 P1 + 3 项裁决 + 1 处事实更正）
- 基线：`main @ 43d789b`（含 P1-A.1 覆盖表种子 `98e02fd`/`af10a8f`）
- 上游规格：`docs/specs/2026-07-23-opencli-app-clone-p0-design.md`
- 并行但**不属本里程碑 DoD**：BrowserBridge spike（见 §11）

---

## 1. 目标、范围、非目标

### 1.1 目标

把执行准入从「一条派生表达式」升级为**逐命令的策略判决协议**，并用一条最小竖切证明这套机器能跑：

1. Host 侧产出逐命令 `PolicyDecision`，成为执行准入的**唯一权威**；
2. 未审定、审定过期、新命令一律 **fail-closed**；
3. 前端不再「跑了才知道不行」，而是渲染 Host 给的判决；
4. 需要告知的命令走**确认协议**，确认可复查、可撤销、随分类漂移失效。

### 1.2 范围

策略元数据 schema、轴定义、准入算法、双哈希（审定 / 判决）；`/catalog/effective` 新端点、`/start` 确认校验、冻结的状态码表；preferences v2 迁移 + acknowledgement 管理 + 独立活动历史；**三条代表命令**的端到端竖切（§9）。

### 1.3 非目标

| 不做 | 归属 |
|---|---|
| 放开 `read/local` 全部 24 条 | 逐条审定后按 tier 进入，不整体开闸 |
| BrowserBridge 任何执行路径（含 41 条 browser-public） | P1-B1b |
| daemon 生命周期 / B′ / 版本门 / PID 清零 | spike + P1-B1b，**不进本里程碑 DoD** |
| `state-get`、宽泛 settings reader | 输出敏感度由参数决定，待 secret-output 切片 |
| `xiaoyuzhou/*` 三条 | 消费并写回持久凭据（`clis/xiaoyuzhou/auth.js:18,40,71,114`）→ 持久凭据专项切片 |
| download / export / cookie-export 家族 | 固定共享目录 `%TEMP%\opencli-download`、时间戳可预测文件名、无 per-run 隔离 |
| `ui` / `intercept`、`write`、`login` | 各自独立威胁模型 |

---

## 2. 术语、信任边界、不变式

### 2.1 信任边界

```
前端（WebView）   只渲染 Host 给的 PolicyDecision；不复制、不重算任何准入规则
      ↓ HTTP/SSE
Host（Node 子进程） **执行准入的唯一权威**：catalog 派生 + 人工 metadata + 双哈希 → 判决
      ↓ spawn
opencli（vendored，固定版） 内部行为不可改，只能在调用前把关
```

### 2.2 不变式（不可协商）

| # | 不变式 |
|---|---|
| **I-P1** | **Host 是执行准入的唯一权威。** 前端置灰只是体验；绕过前端不得获得任何额外执行能力。 |
| **I-P2** | **fail-closed。** metadata 缺失、审定过期、catalog 新增命令 → `unknown` → 拒绝执行。不存在「先放行、后补审定」。 |
| **I-P3** | **显式 deny 优先级最高**，压过 legacy 基线、派生结果与 metadata。 |
| **I-P4** | **snapshot 与 policy 原子同源，且 `revision` 在 wire 上可验**（不靠口头承诺，见 §6.2）。 |
| **I-P5** | **acknowledgement 是防误操作与防陈旧 UI 的协议，不是操作系统权限。** 伪造它只影响提示，不提升任何实际执行能力——判决始终在 Host。 |
| **I-P6** | 沿用 P0-B 冻结契约：**Node 可执行文件、opencli 入口、Host 环境与输出格式由服务端固定**；`argv` 由前端 `buildArgv(values)` 产出用户参数，Host 按**结构、长度、`commandKey===argv[0]/[1]`、强制 `-f json`** 校验后原样传入；`shell:false` 保证参数不进 shell 解释。回环 bind、精确 Origin 不变。 |
| **I-P7** | 参数值永不落盘、永不进活动历史。 |

> **I-P6 的措辞更正（v1 事实错误）**：v1 写作「argv 全为服务端常量」。实测 `server/run-manager.mjs:120-122` 是 `spawn(process.execPath, [opencliEntry, ...request.argv])`——**argv 来自请求**。全常量的是**目录刷新**那条：`server/catalog-service.mjs:38` 的 `[opencliEntry,'list','-f','json']`。v1 把关于后者的真命题搬到了前者头上。

---

## 3. `PolicyMetadata` 与轴定义

### 3.0 前提：`strategy` 不是任何一根安全轴

上游 `strategy` 是**复合调度标签**，同为 `local` 的四条命令语义完全不同：

| 命令 | 实际形态 |
|---|---|
| `trae-cn/setup` | 纯静态文本输出，**不动用任何外部资源** |
| `mercury/reimbursement-plan` | 读用户在本次调用中显式指定的资料 |
| `trae-cn/targets` | 连接运行中的本地 CDP 端点 |
| `xiaoyuzhou/episode` | 走公开网络 **且** 消费/写回本地持久凭据 |

> **裁决：`strategy` 只作 candidate hint，不映射任何正交安全轴。**
> 早前「strategy × browser 零例外」的测量成立，但它证明的是两字段**彼此自洽**，不是 `strategy` 语义等于 transport。**字段自洽 ≠ 字段是我们以为的那个意思。**

### 3.1 轴定义（多值轴用集合，空集即「无」）

```ts
export type PolicyMetadata = {
  executionPath: 'direct-node' | 'browser-bridge'
  authorities: Array<
    | 'public-network' | 'explicit-local-input' | 'ambient-local-files'
    | 'live-local-app' | 'browser-profile'
  >                                    // [] = 不动用任何外部资源
  exposure: 'public' | 'personal' | 'secret' | 'unknown'
  effects: Array<'local-file-write' | 'remote-write'>          // [] = 无副作用
  credentialFlow: 'none' | 'consume' | 'produce' | 'both'
  residues: Array<'temp-file' | 'persistent-session'>          // [] = 无残留
}
```

**为什么 `authorities`/`effects`/`residues` 是集合**：单值表达不了「同时走公开网络与本地凭据」（`xiaoyuzhou/*`），也表达不了「既写本地文件又留 persistent residue」。空数组比造一个 `'none'` 成员更准确——它天然可组合，且不会在未来被迫改语义。

`exposure` 与 `credentialFlow` 保持单值：前者是**级别**（取最高档），后者是**方向**（`both` 已覆盖组合）。

### 3.2 派生 vs 人工

| 轴 | 来源 | 人工面 |
|---|---|---|
| `executionPath` | **可派生**：`browser===true → browser-bridge`。实测 1278 条零例外 | 0 |
| `authorities` | **人工** | 逐命令 |
| `exposure` | **人工**。`columns` 是表格视图不是返回体清单——`paperreview/review` 的 `columns` 无 `token`，返回体却含 `token` 且 `review_url` 内嵌它 | 逐命令 |
| `effects` | `access` 作 candidate hint，人工定案 | 见下 |
| `credentialFlow` | **人工**。参数名正则只产 `sensitiveNameHint`；误报实证：`homebrew/cask --token` 的 token 是 Homebrew 包标识符 | 逐命令 |
| `residues` | `siteSession==='persistent'` 作 hint（实测 284/284 皆 browser），**其缺席证明不了无残留** | 逐命令 |

**`effects` 的人工面不给上界。** 关键词扫描得 51 候选、31 条有源码写入证据、20 条为名称误报（`destination`/`direction` 等）；扫描既误报也漏报**语义隐藏的写入**。启发式只生成候选集。

`sensitiveNameHint`（参数名命中 `/password|passcode|secret|token|cookie/i`，全目录 6 条）**只作审定提示，不参与判决**。

---

## 4. tier 与准入算法

### 4.1 tier

tier 是**候选分组**，进入 tier 只说明「这批命令值得被审定」，不是放行凭据。

| tier | 定义 | 本里程碑 |
|---|---|---|
| `legacy-public-direct` | **随包 snapshot 冻结的基线集**（见 §4.2） | 维持现有 276 条 |
| `local-direct` | `direct-node` 且 `strategy==='local'` | §9 三条进入 |
| `browser-public` | `browser-bridge` 且 `strategy==='public'` | P1-B1b |
| 其余 | — | 不设 tier |

#### 4.1.1 `local-direct` 允许集

| 轴 | 允许值 | 被挡在外的实例 |
|---|---|---|
| `authorities` | ⊆ {`public-network`, `explicit-local-input`, `ambient-local-files`}（含空集） | `live-local-app`（`trae-cn/targets`）、`browser-profile` |
| `exposure` | `public`、`personal` | `secret`（含 `state-get` 一类输出由参数决定的） |
| `effects` | **必须为 `[]`** | download 家族 |
| `credentialFlow` | **必须为 `none`** | `xiaoyuzhou/*` 三条 |
| `residues` | **必须为 `[]`** | `temp-file`、`persistent-session` |

> 这是**「本 tier 不接收」，不是永久排除**。`xiaoyuzhou/*` 进后续持久凭据切片；`state-get` 进 secret-output 切片。

### 4.2 legacy 基线（解决 fail-closed 与现有 276 条的冲突）

现有 276 条**没有人工 metadata**。若直接套 §4.3 算法，它们全部落入 `unknown`——整个应用会失去全部可执行命令。这不是保守，是回归。

```
legacyBaseline = 从**随包 snapshot** 冻结的命令集合
                 { commandKey → reviewShapeHash }
                 （生成规则 = P0-B 三条件派生结果 − 显式 deny）
```

- 命令在基线内 **且** 当前 `reviewShapeHash` 与冻结值一致 → `ready`，`decisionSource='legacy-baseline'`；
- 形状漂移或不在基线内 → 走正常算法（多半 `unknown`）；
- **legacy decision 允许 metadata 缺省**（`metadata` 字段不下发）；
- 基线是**只减不增**的：任何新命令都进不去。

这既维持现状，又杜绝未来静默扩面——**新命令永远无法搭 legacy 的便车**。

### 4.3 准入算法（全函数，顺序即语义）

```
0. catalog 里不存在该命令                     → 不产出 decision
1. 显式 deny                                   → denied（explicit-deny）        [I-P3]
2. legacy 基线命中且形状未漂移                 → ready（legacy-baseline）
3. 未落入任何已启用 tier                       → unknown（no-tier）
4. metadata 缺失                               → unknown（metadata-missing）
5. metadata.reviewedAgainst ≠ 当前 reviewShapeHash
                                               → unknown（review-stale）
6. exposure==='unknown' 或 residues 含 'unknown' 语义未定
                                               → unknown（exposure-unknown / residue-unknown）
7. tier 阈值：authorities / exposure / effects / credentialFlow / **residues** 全部在允许集内
                                     否 → denied（tier-threshold）
8. authorities === ['explicit-local-input']    → ready
       （表单已明示读取对象，选择动作即本次授权；再弹一次是纯噪声）
9. authorities 含 'ambient-local-files' 或 exposure==='personal'
                                               → acknowledgement-required
10. 其余                                        → ready
```

三处 v1 的漏洞已修：**第 6 步必须早于第 7 步**（否则 `exposure==='unknown'` 会先被阈值判成 `denied`，第 7 步永远到不了）；**第 7 步必须含 `residues`**（v1 遗漏，与 §4.1.1 要求矛盾）；**`public-direct` 不再作为需要允许集的 tier 存在**，改由 legacy 基线承接。

第 8 步必须早于第 9 步：`mercury/reimbursement-plan` 是 `explicit-local-input` + `personal`，顺序颠倒就会给它挂上与 §7 矛盾的弹窗。**这是语义，不是风格。**

---

## 5. 双哈希：审定过期 ≠ 确认过期

v1 只有一个指纹，把两件不同的事混为一谈：manifest 变化只会让**用户**重新确认，却不会让**人工审定**重新进行——而新增参数完全可能改变 `effects`/`exposure`，此时旧 metadata 应先回到 `unknown`。

```
reviewShapeHash = sha256(canonicalJson({
  opencliVersion,                    // vendored 版本:实现变了而 manifest 没变时,旧审定必须失效
  commandKey,
  access, strategy, browser, siteSession,
  positionalArgs: [...],             // **保留声明顺序**——位置参数的顺序是语义
  flagArgs: [{name,type,required}]   // 按 name 归一化——flag 顺序无语义
  columns,                           // 只作审定漂移信号
}))

decisionFingerprint = sha256(canonicalJson({
  policySchemaVersion,
  reviewShapeHash,
  effectiveMetadata,
  matchedDenyRule,                   // **该命令实际命中的**规则,不是全局 denyRevision
}))
```

- `metadata.reviewedAgainst = reviewShapeHash`（审定时记录）；
- 用户 acknowledgement 绑 `decisionFingerprint`；
- **无关命令的 deny 变化不再让全部确认失效**（v1 的 `denyRevision` 有此缺陷）；
- `description`/`help`/`example` 变化**不进任何哈希**——不改变安全语义。

| 事件 | 结果 |
|---|---|
| catalog 新增命令 | 无 metadata → `unknown` |
| 相关 manifest 字段 / opencli 版本变化 | `reviewShapeHash` 变 → **审定失效** → `unknown`（需人工重审） |
| metadata 修订 | `decisionFingerprint` 变 → **用户确认失效**（需重新确认，但无需重审） |
| 展示性字段变化 | 不触发任何失效 |

---

## 6. Wire contract（冻结）

### 6.1 `PolicyDecision`

字段的必填性**随 state 变化**——`unknown` 状态本就没有有效 metadata / fingerprint：

```ts
type PolicyDecision = {
  commandKey: string
  state: 'ready' | 'acknowledgement-required' | 'denied' | 'unknown'
  decisionSource: 'legacy-baseline' | 'reviewed-tier' | 'explicit-deny'
  fingerprint?: string          // state ∈ {ready, acknowledgement-required} 时必填
  metadata?: PolicyMetadata     // decisionSource==='reviewed-tier' 时必填
  reasonCode?: string           // 稳定标识,业务逻辑只认它
  reason?: string               // 自然语言,仅供展示
}
```

`reasonCode` 稳定集合：`explicit-deny` / `no-tier` / `metadata-missing` / `review-stale` / `exposure-unknown` / `residue-unknown` / `tier-threshold`。

**`host-offline` 不是 `PolicyDecision`。** 它是前端的连接状态，不得伪造成 Host 产出的判决（否则前端就在自行裁决，违反 I-P1）。Host 离线时前端展示目录并整体标记为「未连接」，不下发也不构造 decision。

### 6.2 `/catalog/effective`（新端点，不改旧契约）

`/catalog` 现返回原始 snapshot，前端 `src/data/catalog.ts` 对其做 `assertCatalogCommands(s.commands)`。**改它的形状会直接破坏既有契约**，故新增端点：

```
GET /catalog            → CatalogSnapshot            （不变）
GET /catalog/effective  → {
                            revision: string,        // 显式,使 I-P4 在 wire 上可验
                            snapshot: CatalogSnapshot,
                            policy: { schemaVersion, generatedAt, decisions: PolicyDecision[] }
                          }
```

`revision` 由 CatalogService 在原子替换时生成，snapshot 与 decisions 共享同一值。**新前端只用 `/catalog/effective`。**

### 6.3 `/start` 与完整状态码表

```ts
{ runId, commandKey, argv, acknowledgement?: { fingerprint: string } }
```

| decision.state | 请求 | 响应 |
|---|---|---|
| `ready` | — | **202** |
| `acknowledgement-required` | 带匹配 fingerprint | **202** |
| `acknowledgement-required` | 未带 acknowledgement | **428** |
| `acknowledgement-required` | fingerprint 不匹配 | **409**（前端重拉 `/catalog/effective`） |
| `denied` | — | **403**（`reasonCode` 区分原因） |
| `unknown` | — | **403** + `reasonCode`（不新造状态码；「未审定」对调用方同样是拒绝） |
| 任意 | 结构非法 | **400** |

`428`/`409` 为新增；`400`/`403`/`202` 语义不变，**不破坏 P0-B 冻结面**。

---

## 7. Acknowledgement UX 与 Host 校验

| 类别 | 粒度 |
|---|---|
| `ambient-local-files` 或 `personal` | **每命令首次确认**，绑 `decisionFingerprint`，可复查可撤销 |
| fingerprint 变化 | 重新确认 |
| `explicit-local-input` | 表单**清晰展示读取对象**；选择动作即本次授权，不额外弹窗 |
| secret-capable reader / write / login | 后续切片，本里程碑不涉及 |

**为什么不每次都确认**：只读、无副作用、本机单用户。每次弹窗会训练出无脑点确认，**把后面 write/login 真正需要逐次确认时的信号强度提前磨钝**。

Host 侧校验（前端的确认只是采集）：`/start` 比对 `acknowledgement.fingerprint` 与当前 `decision.fingerprint`，按 §6.3 表返回。**Host 不信任前端对 state 的判断** [I-P1]。

---

## 8. preferences v2 与活动历史

### 8.1 迁移

```
新 key：'opencli-app:prefs:v2'（v1 键 'opencli-app:prefs:v1' 保留只读，不删）
顺序：读 v2 → 无则读 v1 迁移并写 v2 → 皆无则建空 v2
保留：favoriteSites / favoriteCommands / recent（语义与容量不变）
新增：acknowledgements: Array<{ commandKey, fingerprint, acknowledgedAt }>
损坏记录**逐项丢弃**，不清空整份偏好（沿用块 A 复审确立的口径）
```

**storage 写入失败**（隐私模式 / 配额 / SecurityError）：确认**本次会话内有效**，进程重启后需重新确认。**不静默假装已持久化**——UI 需明示「本次有效」。

### 8.2 活动历史（**不是审计**）

localStorage 不防篡改，叫「审计」名不副实。

```ts
type ActivityEntry = {
  id: string                 // 本地生成,用于去重与更新
  runId: string              // 关联本次运行
  startedAt: number
  finishedAt?: number        // 终态时回填
  commandKey: string
  decisionState: PolicyDecision['state']
  exposure: PolicyMetadata['exposure'] | null   // legacy decision 无 metadata
  acknowledged: boolean
  outcome?: 'success' | 'failed' | 'cancelled' | 'rejected'
}
```

- **独立存储**（`'opencli-app:activity:v1'`），不塞进 preferences；
- **容量上限 200 条**，超出按 `startedAt` 驱逐最旧；可一键清空；
- 写入时机：`/start` 受理时写入首行，终态时按 `id` 回填 `finishedAt`/`outcome`；
- **不记参数值、不记结果、不记错误详情** [I-P7]。

---

## 9. 三命令竖切

### 9.1 代表命令与 metadata 审定（本节即审定记录）

| 类别 | 命令 | 实测形态 |
|---|---|---|
| 无外部资源 | `trae-cn/setup` | `read/local`，**零参数**，输出本地 setup 说明文本 |
| explicit-local-input | `mercury/reimbursement-plan` | `read/local`，**9 参 5 必填**（必填 `receipt`/`amount`/`date`/`merchant`/`notes`；可选 `currency`/`category`/`ocr-wait-seconds`/`close-after-review`），desc 明写 "without opening a browser" |
| ambient-local | `antigravity/recent-paths` | `read/local`，读 `history.recentlyOpenedPathsList`，可选 `limit` |

| 命令 | executionPath | authorities | exposure | effects | credentialFlow | residues | → state |
|---|---|---|---|---|---|---|---|
| `trae-cn/setup` | direct-node | **`[]`** | public | `[]` | none | `[]` | `ready` |
| `mercury/reimbursement-plan` | direct-node | `[explicit-local-input]` | personal | `[]` | none | `[]` | `ready`（第 8 步） |
| `antigravity/recent-paths` | direct-node | `[ambient-local-files]` | personal | `[]` | none | `[]` | `acknowledgement-required` |

> `trae-cn/setup` 的 `authorities` 是**空集**而非 `public-network`——它只是打印本地说明文本，不访问网络。v1 标成 `public-network` 是错的。

### 9.2 真机门替换准则（**现在就定**）

实测：本机 **Antigravity 未安装**、**Trae SOLO 未安装**；Trae CN 已安装但其 `read/local` 只有 `setup`（静态）与 `targets`（`live-local-app`，不属本切片）。

> **本机今天没有任何可用的 `ambient-local-files` 命令。**

1. **自动化测试**一律用合成 catalog + spawn fixture，**不依赖任何本机软件**——硬要求，不是退路；
2. **真机门**按序取第一个可用者，且**替换时必须同时固化其 metadata**（不能只换 commandKey）：

| 备选 | authorities | exposure | 其余 |
|---|---|---|---|
| `antigravity/recent-paths` | `[ambient-local-files]` | personal | `[]` / none / `[]` |
| `trae-solo/recent-workspaces` | `[ambient-local-files]` | personal | `[]` / none / `[]` |
| `trae-solo/workspaces-list` | `[ambient-local-files]` | personal | `[]` / none / `[]` |

3. 三者皆不可用 → 真机门记「**环境不具备，未验**」写进验收报告；**不得以自动测试代替，不得判该项通过，不得宣称 1a 真机闭环**。

### 9.3 失败流程

| 场景 | 期望 |
|---|---|
| `unknown` | 前端置灰 + 就地说明 `reasonCode`；点不动，不发请求；绕过前端直发 → `403` |
| `acknowledgement-required` 未确认直发 | `428` |
| 确认后分类漂移再运行 | `409` → 前端自动重拉 `/catalog/effective` 并提示重新确认 |
| Host 离线 | 前端整体标「未连接」，**不构造 decision** |
| 撤销确认后再运行 | 回到 `acknowledgement-required` |
| storage 不可写 | 确认仅本次会话有效，UI 明示 |

---

## 10. 测试矩阵与两级验收

### 10.1 自动门（不依赖本机软件与网络）→ **代码 DoD**

| # | 断言 | 变异验证 |
|---|---|---|
| 1 | 新增命令无 metadata → `unknown`，`/start` 得 `403` | 去掉 fail-closed → 红 |
| 2 | legacy 基线命中且形状未漂移 → `ready`；**形状漂移 → `unknown`** | 让 legacy 无条件 ready → 红 |
| 3 | **新命令无法进入 legacy 基线**（基线只减不增） | 允许新增进基线 → 红 |
| 4 | 显式 deny 压过 legacy 与 reviewed-tier | 调换算法顺序 → 红 |
| 5 | `exposure==='unknown'` → `unknown` 而非 `denied`（第 6 步早于第 7 步） | 交换两步 → 红 |
| 6 | tier 阈值检查含 `residues` | 移除 residues 检查 → 红 |
| 7 | `explicit-local-input` + `personal` → `ready`（第 8 步早于第 9 步） | 交换两步 → 红 |
| 8 | `reviewShapeHash` 变 → **审定失效**（`review-stale`）；`decisionFingerprint` 变 → **仅确认失效** | 合并成单哈希 → 红 |
| 9 | 无关命令的 deny 变化**不**使其他命令确认失效 | 改回全局 denyRevision → 红 |
| 10 | `description` 变化不触发任何失效 | 纳入哈希 → 红 |
| 11 | 状态码表逐格：202 / 428 / 409 / 403(denied) / 403(unknown) / 400 | — |
| 12 | `/catalog` 形状不变；`/catalog/effective` 的 snapshot 与 decisions 同 `revision` | — |
| 13 | preferences v1 → v2 迁移保留收藏与 recent；坏项逐项丢弃；storage 失败 → 本次有效 | — |
| 14 | 活动历史不含参数值/结果/错误详情；容量上限生效；终态按 id 回填 | 写入参数 → 红 |
| 15 | **前端不自行裁决**（两组对抗 fixture，见下） | — |

**第 15 条的做法**（取代 v1 的源码 grep 断言——那种写法一改就误红）：

- fixture A：manifest **看起来满足**旧派生条件，但 Host 返 `denied`/`unknown` → UI 必须置灰**且不发 `/start`**；
- fixture B：manifest **看起来不满足**旧条件，但 Host 返 `ready` → UI 必须按 Host 判决启用。

两组都过，才证明前端确实只渲染判决、没有自己的规则副本；且不依赖源码写法。

### 10.2 真机证据门（**与代码 DoD 分离**）

1. 三条代表命令各跑一遍（ambient 按 §9.2 替换准则）；
2. 首次确认 → 完全退出 → 重开 → 确认仍在；
3. 撤销 → 再运行 → 回到需确认；
4. 人为改 metadata revision → 既有确认失效。

> **代码 DoD 与真机证据门是两级**：fixture 全过即可合并；真机门待环境具备后补。**未验时不得宣称 1a 真机闭环。**

---

## 11. 残余风险与 spike 链接

| 风险 | 处置 |
|---|---|
| `effects` 人工面规模未知 | 明确不给上界；tier 逐步开放，未审定即 `unknown` |
| localStorage 可被改写 | 已改称「活动历史」；伪造 acknowledgement 只影响提示，不提升执行能力 [I-P5] |
| 前端置灰与 Host 判决短暂不一致 | `409` 兜底；置灰只是体验 [I-P1] |
| legacy 基线冻结的是**当时**的判断 | 基线只减不增；形状漂移即退出基线；后续可逐批补审定迁出 legacy |
| 本机缺 ambient-local 软件 | §9.2 替换准则；不具备则记「未验」，不粉饰 |
| BrowserBridge 外部前提（扩展需用户自装、daemon TOCTOU、B′ 清理承诺） | **链接** BrowserBridge spike brief，不在本里程碑裁决 |
| vendored opencli 内部行为不可控 | `reviewShapeHash` 含 `opencliVersion`：升级即触发全量重审 |

---

## 12. 待确认

无。第一轮评审的 6 组 P1、3 项裁决与 1 处事实更正已全部吸收（对照见各节标注）。
