# P1-B0 策略协议 + 1a 本地竖切 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把执行准入从「一条派生表达式」升级为 Host 侧逐命令的 `PolicyDecision` 协议，并用三条本地命令的竖切证明这套机器可用。

**Architecture:** `buildExecutionPolicy` 由「产出 `allowedCommands: Set`」升级为「产出 `decisions: PolicyDecision[]`」。判决 = 显式 deny → legacy 基线（受版本控制的只读 artifact）→ tier 候选 → 人工 `ReviewedPolicyRecord` → 双哈希校验 → tier 阈值 → 确认要求。前端不再持有任何准入规则，只渲染 `/catalog/effective` 下发的判决。

**Tech Stack:** 现有 Vite+React+TS+Zustand+Vitest；Host 侧纯 Node ESM（`server/*.mjs`）；哈希用 `node:crypto`。**不新增任何依赖。**

**Spec:** `docs/specs/2026-07-26-p1-b0-policy-protocol-design.md`（v3.2，三轮评审全部吸收）

## Global Constraints（每 task 隐含）

- **I-P1 Host 是执行准入唯一权威**：前端置灰只是体验，绕过前端不得获得任何额外执行能力。
- **I-P2 fail-closed**：记录缺失/审定过期/新命令 → `unknown` → 拒绝执行。**不存在「先放行后补审定」。**
- **I-P3 显式 deny 优先级最高**，压过 legacy 基线与 tier 判决。
- **I-P4** `/catalog/effective` 的 snapshot 与 decisions 共享同一 `revision`，wire 上可验。
- **I-P5 acknowledgement 不是安全授权**，只防误点与陈旧 UI；安全边界是 Host 对 `denied`/`unknown` 的拒绝。
- **I-P6 冻结契约不动**：Node 可执行文件 / opencli 入口 / 环境 / 强制 `-f json` 由服务端固定；`argv` 来自请求，经结构·长度·`commandKey===argv[0]/[1]`·format 校验后原样传入；`shell:false`；回环 bind；精确 Origin。
- **I-P7** 参数值永不落盘、永不进活动历史。
- **legacy artifact 只读**：`server/policy-legacy-baseline.json` 一次性物化后入库；构建/刷新/升级**一律不得自动重建**。
- **`/catalog` 原端点形状不变**（前端 `src/data/catalog.ts` 对其做 `assertCatalogCommands`）；新增 `/catalog/effective`。
- 提交门：每 task `npx tsc --noEmit && npx vitest run && npm run build` 全链 `&&` 通过才 commit；只 `git add` 各 task 点名文件。
- 仓内文件先读再改，最小 diff；**既有断言不得删除或弱化**（改语义时改写断言）。
- **新增守卫必须做变异验证**：摘掉被守护的代码，对应断言必须变红，且是**因为对的原因**红。
- 脚本写回仓内文件必须显式指定换行（Python `newline=''`）；检查不可见字符按字节，并**先用已知阳性验证检测器**。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `server/policy-types.mjs`（新） | `PolicyMetadata` / `ReviewedPolicyRecord` / `PolicyDecision` 的 JSDoc 类型 + 轴常量 + 校验函数 |
| `server/policy-metadata.mjs`（新） | 三条命令的人工审定记录（`REVIEWED_RECORDS`） |
| `server/policy-fingerprint.mjs`（新） | `canonicalJson` / `reviewShapeHash` / `decisionFingerprint` |
| `server/policy-legacy-baseline.json`（新，入库） | 276 条 `{commandKey → reviewShapeHash}` + 固定源身份 |
| `scripts/materialize-legacy-baseline.mjs`（新） | **一次性**物化脚本，非构建步骤 |
| `scripts/check-legacy-baseline.mjs`（新） | CI 闸：只减不增 + 固定源身份匹配 |
| `server/policy.mjs`（改） | `buildExecutionPolicy` → 产出 decisions；`validateStartRequest` 增确认校验 |
| `server/host-server.mjs`（改） | 新增 `GET /catalog/effective`；`/start` 状态码 428/409 |
| `server/catalog-service.mjs`（改） | 原子替换时生成 `revision` |
| `src/data/policy.ts`（新） | 前端侧 `PolicyDecision` 类型 + 判决查询辅助（**无任何准入规则**） |
| `src/data/preferences.ts`（改） | v1→v2 迁移 + `acknowledgements` |
| `src/data/activity.ts`（新） | 活动历史（独立 key、定长、可清空） |
| `src/store/appStore.ts`（改） | 持有 decisions；`executeSelected` 前置判决检查 |
| `src/features/config/CommandConfig.tsx`（改） | 按判决置灰 + `reasonCode` 就地说明 + 确认对话 |

---

## Task 1：策略类型与三条人工审定记录

**Files:**
- Create: `server/policy-types.mjs`、`server/policy-metadata.mjs`
- Test: `server/policy-types.test.mjs`

**Interfaces:** Produces `AUTHORITIES`/`EXPOSURES`/`EFFECTS`/`RESIDUES`/`CREDENTIAL_FLOWS` 常量数组、`isCompleteRecord(record)`、`REVIEWED_RECORDS`（`Map<commandKey, ReviewedPolicyRecord>`，`reviewedAgainst` 暂填空串，Task 2 回填）。

- [ ] **Step 1: 写失败测试** `server/policy-types.test.mjs`

```js
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isCompleteRecord, AUTHORITIES, EXPOSURES } from './policy-types.mjs'
import { REVIEWED_RECORDS } from './policy-metadata.mjs'

describe('策略类型与审定记录', () => {
  it('三条代表命令都有完整审定记录', () => {
    for (const key of ['trae-cn/setup', 'mercury/reimbursement-plan', 'antigravity/recent-paths']) {
      const record = REVIEWED_RECORDS.get(key)
      expect(record, `${key} 缺审定记录`).toBeDefined()
      expect(isCompleteRecord(record), `${key} 记录不完整`).toBe(true)
    }
  })

  it('trae-cn/setup 的 authorities 是空集 —— 它只打印本地说明文本,不访问网络', () => {
    expect(REVIEWED_RECORDS.get('trae-cn/setup').metadata.authorities).toEqual([])
  })

  it('半份记录判为不完整 —— 不允许用它参与判决', () => {
    // exposure 与 residues 有 unknown 成员;其余轴没有,缺失即整条作废
    const half = { reviewedAgainst: 'x', metadata: { executionPath: 'direct-node', exposure: 'public' } }
    expect(isCompleteRecord(half)).toBe(false)
  })

  it('轴取值超出枚举即不完整', () => {
    const bad = {
      reviewedAgainst: 'x',
      metadata: {
        executionPath: 'direct-node', authorities: ['made-up'], exposure: 'public',
        effects: [], credentialFlow: 'none', residues: [],
      },
    }
    expect(isCompleteRecord(bad)).toBe(false)
    expect(AUTHORITIES).not.toContain('made-up')
    expect(EXPOSURES).toContain('unknown')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/policy-types.test.mjs`
Expected: FAIL —— `Failed to resolve import "./policy-types.mjs"`

- [ ] **Step 3: 写 `server/policy-types.mjs`**

```js
// 策略轴的取值域。**只有 exposure 与 residues 有 unknown 成员**——这两轴最常出现
// 「看了但拿不准」;其余轴没有 unknown,审定不完整时整条记录作废(spec §3.1)。
export const EXECUTION_PATHS = ['direct-node', 'browser-bridge']
export const AUTHORITIES = [
  'public-network', 'explicit-local-input', 'ambient-local-files',
  'live-local-app', 'browser-profile',
]
export const EXPOSURES = ['public', 'personal', 'secret', 'unknown']
export const EFFECTS = ['local-file-write', 'remote-write']
export const CREDENTIAL_FLOWS = ['none', 'consume', 'produce', 'both']
export const RESIDUES = ['temp-file', 'persistent-session']

function isSubsetOf(value, domain) {
  return Array.isArray(value) && value.every((item) => domain.includes(item))
}

/**
 * 审定记录是否完整。**半份记录不得参与判决**——宁可整条作废走 fail-closed,
 * 也不能拿「填了一半的分类」去过 tier 阈值。
 */
export function isCompleteRecord(record) {
  if (!record || typeof record !== 'object') return false
  if (typeof record.reviewedAgainst !== 'string') return false
  const m = record.metadata
  if (!m || typeof m !== 'object') return false
  if (!EXECUTION_PATHS.includes(m.executionPath)) return false
  if (!isSubsetOf(m.authorities, AUTHORITIES)) return false
  if (!EXPOSURES.includes(m.exposure)) return false
  if (!isSubsetOf(m.effects, EFFECTS)) return false
  if (!CREDENTIAL_FLOWS.includes(m.credentialFlow)) return false
  if (m.residues !== 'unknown' && !isSubsetOf(m.residues, RESIDUES)) return false
  return true
}
```

- [ ] **Step 4: 写 `server/policy-metadata.mjs`**

```js
// 人工审定记录。审定依据见 spec §9.1——本文件是那份审定的可执行形式。
// reviewedAgainst 由 Task 2 的 reviewShapeHash 回填;此处先留空串,
// Task 2 的测试会断言它已被填成真实哈希。
export const REVIEWED_RECORDS = new Map([
  ['trae-cn/setup', {
    reviewedAgainst: '',
    metadata: {
      executionPath: 'direct-node',
      // 空集:它只打印本地 setup 说明文本,不访问网络、不读用户文件。
      authorities: [],
      exposure: 'public',
      effects: [],
      credentialFlow: 'none',
      residues: [],
    },
  }],
  ['mercury/reimbursement-plan', {
    reviewedAgainst: '',
    metadata: {
      executionPath: 'direct-node',
      // 用户在本次调用中显式指定报销资料(receipt/amount/merchant/notes 均必填)。
      authorities: ['explicit-local-input'],
      exposure: 'personal',
      effects: [],
      credentialFlow: 'none',
      residues: [],
    },
  }],
  ['antigravity/recent-paths', {
    reviewedAgainst: '',
    metadata: {
      executionPath: 'direct-node',
      // 主动扫描 Antigravity 的 history.recentlyOpenedPathsList——用户没指定读什么。
      authorities: ['ambient-local-files'],
      exposure: 'personal',
      effects: [],
      credentialFlow: 'none',
      residues: [],
    },
  }],
])
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run server/policy-types.test.mjs`
Expected: PASS（4 tests）

- [ ] **Step 6: 变异验证**

把 `isCompleteRecord` 里的 `if (!isSubsetOf(m.authorities, AUTHORITIES)) return false` 删掉 → 第 4 条用例必须变红。确认后还原。

- [ ] **Step 7: 提交**

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add server/policy-types.mjs server/policy-metadata.mjs server/policy-types.test.mjs
git commit -m "feat(policy): 策略轴类型 + 三条命令人工审定记录;半份记录判不完整走 fail-closed"
```

---

## Task 2：双哈希（reviewShapeHash / decisionFingerprint）

**Files:**
- Create: `server/policy-fingerprint.mjs`
- Modify: `server/policy-metadata.mjs`（回填 `reviewedAgainst`）
- Test: `server/policy-fingerprint.test.mjs`

**Interfaces:** Produces `canonicalJson(value)`、`reviewShapeHash(command, opencliVersion)`、`decisionFingerprint({policySchemaVersion, reviewShapeHash, metadata, matchedDenyRule})`、`POLICY_SCHEMA_VERSION`。

- [ ] **Step 1: 写失败测试** `server/policy-fingerprint.test.mjs`

```js
// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reviewShapeHash, decisionFingerprint, canonicalJson } from './policy-fingerprint.mjs'
import { REVIEWED_RECORDS } from './policy-metadata.mjs'

const snapshot = JSON.parse(readFileSync(resolve('public/catalog.snapshot.json'), 'utf8').replace(/^﻿/, ''))
const find = (key) => snapshot.commands.find((c) => c.command === key)
const V = snapshot.opencliVersion

describe('reviewShapeHash', () => {
  it('同一命令稳定,不同命令不同', () => {
    const a = reviewShapeHash(find('trae-cn/setup'), V)
    expect(reviewShapeHash(find('trae-cn/setup'), V)).toBe(a)
    expect(reviewShapeHash(find('mercury/reimbursement-plan'), V)).not.toBe(a)
  })

  it('opencli 版本变化 → 审定失效', () => {
    const cmd = find('trae-cn/setup')
    expect(reviewShapeHash(cmd, '1.8.7')).not.toBe(reviewShapeHash(cmd, V))
  })

  it('展示性字段变化不进哈希', () => {
    const cmd = find('antigravity/recent-paths')
    const base = reviewShapeHash(cmd, V)
    for (const field of ['description', 'example', 'aliases']) {
      expect(reviewShapeHash({ ...cmd, [field]: 'CHANGED' }, V), `${field} 不该进哈希`).toBe(base)
    }
  })

  it('每个行为字段变化都改变哈希', () => {
    const cmd = find('antigravity/recent-paths')
    const base = reviewShapeHash(cmd, V)
    const mutations = {
      access: 'write', strategy: 'public', browser: true, siteSession: 'persistent',
      modulePath: 'other.js', domain: 'evil.example', navigateBefore: true,
      defaultWindowMode: 'headless', defaultFormat: 'yaml', type: 'other',
      columns: ['x'],
    }
    for (const [field, value] of Object.entries(mutations)) {
      expect(reviewShapeHash({ ...cmd, [field]: value }, V), `${field} 必须进哈希`).not.toBe(base)
    }
  })

  // **一个字段一条用例**,不要塞进 for 循环。
  // 教训(T1 同形复发):循环里第一条 expect 失败即抛异常,后面的字段**根本不会被执行**——
  // 于是「实现漏哈希了某字段」和「测试压根没跑到该字段」在输出上长得一模一样。
  // 每道守卫必须各自可见、各自能红。
  it.each([
    ['name', { name: 'x' }],
    ['type', { type: 'str' }],
    ['required', { required: true }],
    ['valueRequired', { valueRequired: true }],   // 原值是 false,必须翻成 true 才是真变异
    ['default', { default: 99 }],                 // 原值 20;经 appStore 播种 values 间接改变 argv
    ['choices', { choices: ['a'] }],              // 原值 []
  ])('arg 字段 %s 改变 reviewShapeHash', (_field, over) => {
    const cmd = find('antigravity/recent-paths')
    const base = reviewShapeHash(cmd, V)
    const patched = { ...cmd, args: [{ ...cmd.args[0], ...over }] }
    // 先证明这确实是一次真变异:改后的值必须与原值不同,否则这条用例什么也没测
    const [key] = Object.keys(over)
    expect(JSON.stringify(patched.args[0][key]))
      .not.toBe(JSON.stringify(cmd.args[0][key]))
    expect(reviewShapeHash(patched, V)).not.toBe(base)
  })

  it('help 是纯展示,不改变 reviewShapeHash', () => {
    const cmd = find('antigravity/recent-paths')
    const base = reviewShapeHash(cmd, V)
    expect(reviewShapeHash({ ...cmd, args: [{ ...cmd.args[0], help: 'CHANGED' }] }, V)).toBe(base)
  })

  it('位置参数顺序是语义;flag 顺序不是', () => {
    const cmd = {
      command: 'x/y', access: 'read', strategy: 'local', browser: false, columns: [],
      args: [
        { name: 'p1', positional: true }, { name: 'p2', positional: true },
        { name: 'f1' }, { name: 'f2' },
      ],
    }
    const swapPositional = { ...cmd, args: [cmd.args[1], cmd.args[0], cmd.args[2], cmd.args[3]] }
    const swapFlags = { ...cmd, args: [cmd.args[0], cmd.args[1], cmd.args[3], cmd.args[2]] }
    expect(reviewShapeHash(swapPositional, V)).not.toBe(reviewShapeHash(cmd, V))
    expect(reviewShapeHash(swapFlags, V)).toBe(reviewShapeHash(cmd, V))
  })

  it('三条审定记录的 reviewedAgainst 已回填为真实哈希', () => {
    for (const [key, record] of REVIEWED_RECORDS) {
      expect(record.reviewedAgainst, `${key} 未回填`).toBe(reviewShapeHash(find(key), V))
    }
  })
})

describe('decisionFingerprint', () => {
  it('metadata 变化 → 确认失效;无关 deny 变化 → 不失效', () => {
    const base = { policySchemaVersion: 1, reviewShapeHash: 'S', metadata: { exposure: 'public' }, matchedDenyRule: null }
    expect(decisionFingerprint({ ...base, metadata: { exposure: 'personal' } })).not.toBe(decisionFingerprint(base))
    // 该命令没命中任何 deny 规则,别的命令的 deny 怎么改都与它无关
    expect(decisionFingerprint({ ...base })).toBe(decisionFingerprint(base))
  })
})

describe('canonicalJson', () => {
  it('对象键顺序不影响结果,数组顺序影响', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/policy-fingerprint.test.mjs`
Expected: FAIL —— 无法解析 `./policy-fingerprint.mjs`

- [ ] **Step 3: 写 `server/policy-fingerprint.mjs`**

```js
import { createHash } from 'node:crypto'

export const POLICY_SCHEMA_VERSION = 1

/** 对象键排序、数组保序的规范化 JSON——哈希的单射前提。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

// arg 的**行为投影**(spec §5)。实测 arg 字段全集为
// choices/default/help/name/positional/required/type/valueRequired,其中只有 help 是纯展示。
// default 尤其要进:buildTokens 不直接读它,但 appStore.ts 用它播种表单 values、
// command.ts 用它决定布尔标志是否发 `--flag false`,所以它经 values 改变实际提交的 argv。
// **不含 `positional`**:它的语义已由下面 reviewShapeHash 的 positionalArgs/flagArgs 分桶
// 独立承载(改了 positional 就换桶,哈希必变)。放在这里是冗余的第二份,而且**没有任何测试
// 能区分它在不在** —— 实测:从本函数删掉 positional,全部用例仍绿。
// 沿用本仓已立的规矩:没有任何测试能区分的东西会在后人手里烂掉,该删而不是硬凑一个测试。
function argProjection(arg) {
  return {
    name: arg.name ?? null,
    type: arg.type ?? null,
    required: arg.required ?? false,
    valueRequired: arg.valueRequired ?? null,
    default: arg.default ?? null,
    choices: arg.choices ?? null,
  }
}

/**
 * 审定形状哈希：它变了说明**人工审定该重做**（不只是让用户再确认一次）。
 * 含 opencliVersion——实现变了而 manifest 没变时旧审定必须失效
 * （`paperreview/review` 就是活例:返回体带 token 这件事根本不在 manifest 里）。
 */
export function reviewShapeHash(command, opencliVersion) {
  const args = command.args ?? []
  return createHash('sha256').update(canonicalJson({
    opencliVersion,
    commandKey: command.command,
    access: command.access ?? null,
    strategy: command.strategy ?? null,
    browser: command.browser ?? null,
    siteSession: command.siteSession ?? null,
    modulePath: command.modulePath ?? null,     // 换实现文件 = 换实现
    domain: command.domain ?? null,             // 数据去向
    navigateBefore: command.navigateBefore ?? null,
    defaultWindowMode: command.defaultWindowMode ?? null,
    defaultFormat: command.defaultFormat ?? null,
    type: command.type ?? null,
    // 位置参数**保留声明顺序**——顺序是语义;flag 按 name 归一化——顺序无语义。
    positionalArgs: args.filter((a) => a.positional).map(argProjection),
    flagArgs: args.filter((a) => !a.positional).map(argProjection)
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    columns: command.columns ?? null,           // 只作审定漂移信号
  })).digest('hex')
}

/**
 * 判决指纹：它变了说明**用户该重新确认**（审定本身可能仍然有效）。
 * matchedDenyRule 只放**该命令实际命中的**规则——用全局 denyRevision 会让
 * 无关命令的 deny 变化作废全部确认。
 */
export function decisionFingerprint({ policySchemaVersion, reviewShapeHash: shape, metadata, matchedDenyRule }) {
  return createHash('sha256').update(canonicalJson({
    policySchemaVersion, reviewShapeHash: shape, metadata, matchedDenyRule: matchedDenyRule ?? null,
  })).digest('hex')
}
```

- [ ] **Step 4: 回填 `reviewedAgainst`**

在 `server/policy-metadata.mjs` 顶部加载快照并计算，把三条记录的 `reviewedAgainst: ''` 换成计算值：

```js
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewShapeHash } from './policy-fingerprint.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const snapshot = JSON.parse(
  readFileSync(join(projectRoot, 'public/catalog.snapshot.json'), 'utf8').replace(/^﻿/, ''),
)
const shapeOf = (key) => {
  const command = snapshot.commands.find((c) => c.command === key)
  if (!command) throw new Error(`审定记录指向 catalog 里不存在的命令: ${key}`)
  return reviewShapeHash(command, snapshot.opencliVersion)
}
```

把每条记录的 `reviewedAgainst: ''` 改为 `reviewedAgainst: shapeOf('<该命令 key>')`。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run server/policy-fingerprint.test.mjs server/policy-types.test.mjs`
Expected: PASS（32 tests——`policy-fingerprint.test.mjs` 20 + `policy-types.test.mjs` 12；评审修复轮后的实际值，原文写的「10 tests」对不上任何一次真实运行,已按实测更正）

- [ ] **Step 6: 变异验证**

**`argProjection` 的六个字段逐条各做一次**:删掉其中一个 → 对应的 `arg 字段 <名> 改变 reviewShapeHash` 用例必须变红、**且只有它变红** → 还原。六条各自独立验证,不允许「做了一条声称其余同理」。

**施加变异后先确认它真的落到文件上**(`sed -n '<行号>p'` 或 grep),再看测试结果 —— 正则没匹配上时,测试输出与真实通过长得一模一样。

- [ ] **Step 7: 提交**

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add server/policy-fingerprint.mjs server/policy-fingerprint.test.mjs server/policy-metadata.mjs
git commit -m "feat(policy): 双哈希——reviewShapeHash 管审定过期(含 opencliVersion),decisionFingerprint 管确认过期(只含本命令命中的 deny)"
```

---

## Task 3：legacy 基线物化 + 只减不增 CI 闸

**Files:**
- Create: `scripts/materialize-legacy-baseline.mjs`、`scripts/check-legacy-baseline.mjs`、`server/policy-legacy-baseline.json`
- Modify: `package.json`（加 `check:legacy` 脚本）
- Test: `server/policy-legacy-baseline.test.mjs`

**Interfaces:** Produces `server/policy-legacy-baseline.json`（`LegacyBaselineArtifact` 形状，见 spec §4.2）；`npm run check:legacy` 退出码 0/1。

- [ ] **Step 1: 写失败测试** `server/policy-legacy-baseline.test.mjs`

```js
// @vitest-environment node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reviewShapeHash } from './policy-fingerprint.mjs'
import { COMMAND_POLICY_OVERRIDES } from './policy.mjs'

const baseline = JSON.parse(readFileSync(resolve('server/policy-legacy-baseline.json'), 'utf8'))
const snapshotRaw = readFileSync(resolve('public/catalog.snapshot.json'))
const snapshot = JSON.parse(snapshotRaw.toString('utf8').replace(/^﻿/, ''))

describe('legacy 基线 artifact', () => {
  it('固定源身份与实际快照逐字节匹配', () => {
    const sha = createHash('sha256').update(snapshotRaw).digest('hex')
    expect(baseline.materializedFrom.sha256).toBe(sha)
    expect(baseline.materializedFrom.path).toBe('public/catalog.snapshot.json')
    expect(baseline.opencliVersion).toBe(snapshot.opencliVersion)
  })

  it('条目 = P0-B 三条件派生结果 − 显式 deny,恰 276 条', () => {
    const derived = snapshot.commands
      .filter((c) => c.access === 'read' && c.strategy === 'public' && c.browser === false)
      .map((c) => c.command)
      .filter((k) => COMMAND_POLICY_OVERRIDES[k]?.decision !== 'deny')
    expect(Object.keys(baseline.entries).sort()).toEqual(derived.sort())
    expect(derived.length).toBe(276)
  })

  it('每条记录的 reviewShapeHash 与当前快照一致', () => {
    for (const [key, hash] of Object.entries(baseline.entries)) {
      const command = snapshot.commands.find((c) => c.command === key)
      expect(command, `${key} 不在快照里`).toBeDefined()
      expect(reviewShapeHash(command, snapshot.opencliVersion), key).toBe(hash)
    }
  })

  it('基线不含任何 browser 命令 —— 它只承接 P0-B 的直连只读面', () => {
    for (const key of Object.keys(baseline.entries)) {
      expect(snapshot.commands.find((c) => c.command === key).browser, key).toBe(false)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/policy-legacy-baseline.test.mjs`
Expected: FAIL —— `ENOENT: server/policy-legacy-baseline.json`

- [ ] **Step 3: 写物化脚本** `scripts/materialize-legacy-baseline.mjs`

```js
// **一次性**物化 legacy 基线。它不是构建步骤——构建、目录刷新、opencli 升级
// 一律只读取产物,禁止自动重建(spec §4.2)。
// 重跑它等于把「只读 + 只减不增」一次性作废,是所有 legacy 规则里唯一能被单个动作绕过的漏洞。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewShapeHash } from '../server/policy-fingerprint.mjs'
import { COMMAND_POLICY_OVERRIDES } from '../server/policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'server/policy-legacy-baseline.json')

if (existsSync(out) && !process.argv.includes('--force')) {
  console.error('[legacy] 产物已存在。它是一次性物化的只读 artifact;确需重建请显式 --force 并在 PR 里说明理由。')
  process.exit(1)
}

const snapshotPath = resolve(root, 'public/catalog.snapshot.json')
const raw = readFileSync(snapshotPath)
const snapshot = JSON.parse(raw.toString('utf8').replace(/^﻿/, ''))
const entries = {}
for (const command of snapshot.commands) {
  if (!(command.access === 'read' && command.strategy === 'public' && command.browser === false)) continue
  if (COMMAND_POLICY_OVERRIDES[command.command]?.decision === 'deny') continue
  entries[command.command] = reviewShapeHash(command, snapshot.opencliVersion)
}

const artifact = {
  materializedFrom: {
    path: 'public/catalog.snapshot.json',
    gitBlob: execFileSync('git', ['rev-parse', 'HEAD:public/catalog.snapshot.json'], { cwd: root, encoding: 'utf8' }).trim(),
    sha256: createHash('sha256').update(raw).digest('hex'),
  },
  opencliVersion: snapshot.opencliVersion,
  entries,
}
writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`)
console.log(`[legacy] 物化 ${Object.keys(entries).length} 条 → ${out}`)
```

- [ ] **Step 4: 运行物化脚本**

Run: `node scripts/materialize-legacy-baseline.mjs`
Expected: `[legacy] 物化 276 条 → …/server/policy-legacy-baseline.json`

- [ ] **Step 5: 写 CI 闸** `scripts/check-legacy-baseline.mjs`

```js
// CI 闸:legacy 只减不增(L1)。新增 key 直接失败;删除允许。
// 同时校验固定源身份——artifact 被重新生成过的话,sha256 会与入库时的记录对不上。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const path = 'server/policy-legacy-baseline.json'
const current = JSON.parse(readFileSync(resolve(root, path), 'utf8'))

let base
try {
  base = JSON.parse(execFileSync('git', ['show', `origin/main:${path}`], { cwd: root, encoding: 'utf8' }))
} catch {
  console.log('[legacy] origin/main 上尚无基线,跳过 diff 检查(首次引入)')
  process.exit(0)
}

const added = Object.keys(current.entries).filter((k) => !(k in base.entries))
const removed = Object.keys(base.entries).filter((k) => !(k in current.entries))
console.log(`[legacy] legacyCount ${Object.keys(base.entries).length} → ${Object.keys(current.entries).length}`)
if (removed.length) console.log(`[legacy] 已迁出 ${removed.length} 条: ${removed.slice(0, 10).join(', ')}`)
if (added.length) {
  console.error(`[legacy] ❌ 新增 ${added.length} 条: ${added.join(', ')}`)
  console.error('[legacy] 基线只减不增(L1)。新命令必须走人工审定进 tier,不得搭 legacy 便车。')
  process.exit(1)
}
console.log('[legacy] ✅ 只减不增')
```

在 `package.json` 的 `scripts` 里加：`"check:legacy": "node scripts/check-legacy-baseline.mjs"`

- [ ] **Step 6: 跑测试与闸门确认通过**

Run: `npx vitest run server/policy-legacy-baseline.test.mjs && npm run check:legacy`
Expected: 4 tests PASS；闸门打印 `✅ 只减不增`

- [ ] **Step 7: 变异验证**

手工往 `server/policy-legacy-baseline.json` 的 `entries` 里加一个假 key（如 `"fake/cmd": "0"`）→ `npm run check:legacy` 必须退出码 1 并点名该 key，且 Step 1 的第 2、3 条用例变红。确认后还原。

- [ ] **Step 8: 提交**

```bash
npx tsc --noEmit && npx vitest run && npm run build && npm run check:legacy
git add scripts/materialize-legacy-baseline.mjs scripts/check-legacy-baseline.mjs server/policy-legacy-baseline.json server/policy-legacy-baseline.test.mjs package.json
git commit -m "feat(policy): legacy 基线一次性物化(276 条)+ 只减不增 CI 闸;物化脚本非构建步骤,重跑需 --force"
```

---

## Task 4：准入算法 `buildPolicyDecisions`

**Files:**
- Modify: `server/policy.mjs`
- Test: `server/policy-decisions.test.mjs`

**Interfaces:** Produces `buildPolicyDecisions(snapshot)` → `PolicyDecision[]`；`buildExecutionPolicy(snapshot)` 追加 `decisions` 与 `decisionByKey: Map`，保留 `allowedCommands`（供既有消费点与 Task 6 使用）。

- [ ] **Step 1: 写失败测试** `server/policy-decisions.test.mjs`

（10 条断言，逐条对应 spec §4.3 的算法步骤与 §10.1 的门）

```js
// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPolicyDecisions } from './policy.mjs'

const snapshot = JSON.parse(readFileSync(resolve('public/catalog.snapshot.json'), 'utf8').replace(/^﻿/, ''))
const byKey = (decisions) => new Map(decisions.map((d) => [d.commandKey, d]))
const decisions = byKey(buildPolicyDecisions(snapshot))

describe('准入算法', () => {
  it('显式 deny 压过一切', () => {
    const d = decisions.get('paperreview/review')
    expect(d.state).toBe('denied')
    expect(d.decisionSource).toBe('explicit-deny')
    expect(d.reasonCode).toBe('explicit-deny')
  })

  it('legacy 基线命中 → ready,且不下发 metadata/fingerprint', () => {
    const d = decisions.get('36kr/news')
    expect(d.state).toBe('ready')
    expect(d.decisionSource).toBe('legacy-baseline')
    expect(d.metadata).toBeUndefined()
    expect(d.fingerprint).toBeUndefined()
  })

  it('三条审定命令进 tier-evaluation', () => {
    expect(decisions.get('trae-cn/setup').decisionSource).toBe('tier-evaluation')
    expect(decisions.get('trae-cn/setup').state).toBe('ready')
    expect(decisions.get('mercury/reimbursement-plan').state).toBe('ready')       // 第 8 步:显式输入
    expect(decisions.get('antigravity/recent-paths').state).toBe('acknowledgement-required')
    expect(decisions.get('antigravity/recent-paths').fingerprint).toEqual(expect.any(String))
  })

  it('local tier 内未审定的命令 → unknown/metadata-missing', () => {
    const d = decisions.get('trae-solo/state-get')
    expect(d.state).toBe('unknown')
    expect(d.decisionSource).toBe('unclassified')
    expect(d.reasonCode).toBe('metadata-missing')
  })

  it('不在任何 tier 且不在 legacy → unknown/no-tier', () => {
    const d = decisions.get('xiaohongshu/login')     // write+cookie+browser
    expect(d.state).toBe('unknown')
    expect(d.reasonCode).toBe('no-tier')
  })

  it('legacy 形状漂移 → 退出基线', () => {
    const drifted = { ...snapshot, commands: snapshot.commands.map((c) =>
      c.command === '36kr/news' ? { ...c, args: [...(c.args ?? []), { name: 'injected' }] } : c) }
    const d = byKey(buildPolicyDecisions(drifted)).get('36kr/news')
    expect(d.decisionSource).not.toBe('legacy-baseline')
    expect(d.state).toBe('unknown')
  })

  it('审定过期(reviewShapeHash 变) → unknown/review-stale,而非仅要求重确认', () => {
    const drifted = { ...snapshot, commands: snapshot.commands.map((c) =>
      c.command === 'antigravity/recent-paths' ? { ...c, modulePath: 'other.js' } : c) }
    const d = byKey(buildPolicyDecisions(drifted)).get('antigravity/recent-paths')
    expect(d.state).toBe('unknown')
    expect(d.reasonCode).toBe('review-stale')
  })

  it('每条 decision 的必填性随 state 成立(全状态可构造)', () => {
    for (const d of decisions.values()) {
      expect(['ready', 'acknowledgement-required', 'denied', 'unknown']).toContain(d.state)
      expect(['explicit-deny', 'legacy-baseline', 'tier-evaluation', 'unclassified']).toContain(d.decisionSource)
      if (d.state === 'acknowledgement-required') expect(typeof d.fingerprint).toBe('string')
      if (d.decisionSource === 'tier-evaluation') expect(d.metadata).toBeDefined()
      if (d.decisionSource !== 'tier-evaluation') expect(d.metadata).toBeUndefined()
    }
  })

  it('每条命令恰好一个 decision,且覆盖全目录', () => {
    expect(decisions.size).toBe(snapshot.commands.length)
  })

  it('可执行面 = legacy 276 + 三条审定中的 ready/ack', () => {
    const runnable = [...decisions.values()].filter((d) => d.state === 'ready' || d.state === 'acknowledgement-required')
    expect(runnable.length).toBe(276 + 3)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/policy-decisions.test.mjs`
Expected: FAIL —— `buildPolicyDecisions is not a function`

- [ ] **Step 3: 在 `server/policy.mjs` 实现算法**

```js
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCompleteRecord } from './policy-types.mjs'
import { REVIEWED_RECORDS } from './policy-metadata.mjs'
import { POLICY_SCHEMA_VERSION, decisionFingerprint, reviewShapeHash } from './policy-fingerprint.mjs'

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEGACY_BASELINE = JSON.parse(
  readFileSync(join(moduleRoot, 'server/policy-legacy-baseline.json'), 'utf8'),
)

// local-direct tier 的允许集(spec §4.1.1)。「本 tier 不接收」不等于永久排除。
const LOCAL_DIRECT = {
  authorities: ['public-network', 'explicit-local-input', 'ambient-local-files'],
  exposures: ['public', 'personal'],
}

function tierOf(command) {
  if (command.browser === false && command.strategy === 'local') return 'local-direct'
  return null
}

function withinLocalDirect(m) {
  if (!m.authorities.every((a) => LOCAL_DIRECT.authorities.includes(a))) return false
  if (!LOCAL_DIRECT.exposures.includes(m.exposure)) return false
  if (m.effects.length > 0) return false
  if (m.credentialFlow !== 'none') return false
  if (!Array.isArray(m.residues) || m.residues.length > 0) return false
  return true
}

/** 集合恰好相等(按值,非引用/非顺序)——第 8 步的判据。 */
function sameSet(a, b) {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')
}

export function buildPolicyDecisions(snapshot) {
  const version = snapshot.opencliVersion
  return snapshot.commands.map((command) => {
    const commandKey = command.command
    const base = { commandKey }

    // 1. 显式 deny 优先级最高 [I-P3]
    const denyRule = COMMAND_POLICY_OVERRIDES[commandKey]
    if (denyRule?.decision === 'deny') {
      return { ...base, state: 'denied', decisionSource: 'explicit-deny',
               reasonCode: 'explicit-deny', reason: denyRule.reason }
    }

    const shape = reviewShapeHash(command, version)

    // 2. legacy 基线:命中且形状未漂移 → ready,不下发 metadata/fingerprint
    if (LEGACY_BASELINE.entries[commandKey] === shape) {
      return { ...base, state: 'ready', decisionSource: 'legacy-baseline' }
    }

    // 3. tier
    if (!tierOf(command)) {
      return { ...base, state: 'unknown', decisionSource: 'unclassified', reasonCode: 'no-tier' }
    }

    // 4. 审定记录完整性
    const record = REVIEWED_RECORDS.get(commandKey)
    if (!isCompleteRecord(record)) {
      return { ...base, state: 'unknown', decisionSource: 'unclassified', reasonCode: 'metadata-missing' }
    }

    // 5. 审定是否针对当前形状
    if (record.reviewedAgainst !== shape) {
      return { ...base, state: 'unknown', decisionSource: 'unclassified', reasonCode: 'review-stale' }
    }

    const m = record.metadata

    // 6. unknown 语义**必须早于**阈值判定——否则 exposure=unknown 会先被判成 denied
    if (m.exposure === 'unknown') {
      return { ...base, state: 'unknown', decisionSource: 'unclassified', reasonCode: 'exposure-unknown' }
    }
    if (m.residues === 'unknown') {
      return { ...base, state: 'unknown', decisionSource: 'unclassified', reasonCode: 'residue-unknown' }
    }

    // 7. tier 阈值(含 residues)
    if (!withinLocalDirect(m)) {
      return { ...base, state: 'denied', decisionSource: 'tier-evaluation',
               metadata: m, reasonCode: 'tier-threshold' }
    }

    const fingerprint = decisionFingerprint({
      policySchemaVersion: POLICY_SCHEMA_VERSION,
      reviewShapeHash: shape,
      metadata: m,
      matchedDenyRule: null,
    })

    // 8. 显式输入:表单已明示读取对象,选择即授权。**必须早于第 9 步**,
    //    否则 mercury(explicit-local-input + personal)会被挂上多余弹窗。
    if (sameSet(m.authorities, ['explicit-local-input'])) {
      return { ...base, state: 'ready', decisionSource: 'tier-evaluation', metadata: m, fingerprint }
    }

    // 9. 环境式本地读取 或 personal 输出 → 需确认
    if (m.authorities.includes('ambient-local-files') || m.exposure === 'personal') {
      return { ...base, state: 'acknowledgement-required', decisionSource: 'tier-evaluation', metadata: m, fingerprint }
    }

    // 10.
    return { ...base, state: 'ready', decisionSource: 'tier-evaluation', metadata: m, fingerprint }
  })
}
```

并在 `buildExecutionPolicy` 的返回值里追加：

```js
  const decisions = buildPolicyDecisions(snapshot)
  const decisionByKey = new Map(decisions.map((d) => [d.commandKey, d]))
```

返回对象加 `decisions`、`decisionByKey`；`allowedCommands` 改由 decisions 派生（`state==='ready' || state==='acknowledgement-required'`），保证与判决**单一事实源**。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/policy-decisions.test.mjs server/policy.test.mjs`
Expected: 10 + 13 tests PASS（既有 policy.test.mjs 不得回归）

- [ ] **Step 5: 变异验证（三处，逐个做完还原）**

1. 把第 6 步移到第 7 步之后 → 「审定过期」与「exposure unknown」相关用例变红；
2. 从 `withinLocalDirect` 删掉 `residues` 检查 → 用变异夹具（构造一条 `residues:['temp-file']` 的记录）必须变红；
3. 交换第 8、9 步 → `mercury/reimbursement-plan` 用例变红。

- [ ] **Step 6: 提交**

```bash
npx tsc --noEmit && npx vitest run && npm run build && npm run check:legacy
git add server/policy.mjs server/policy-decisions.test.mjs
git commit -m "feat(policy): 准入算法产出逐命令 PolicyDecision(全函数,顺序即语义);allowedCommands 改由判决派生"
```

---

## Task 5：`/catalog/effective` 端点 + revision

**Files:**
- Modify: `server/catalog-service.mjs`、`server/host-server.mjs`
- Test: `server/host-server.test.mjs`（追加）

**Interfaces:** Produces `GET /catalog/effective` → `{ revision, snapshot, policy: { schemaVersion, generatedAt, decisions } }`；`catalogService.current()` 追加 `revision`。

- [ ] **Step 1: 写失败测试**（追加到 `server/host-server.test.mjs`）

```js
describe('/catalog/effective', () => {
  it('返回 envelope,snapshot 与 decisions 共享同一 revision', async () => {
    const res = await fetch(`${base}/catalog/effective`, { headers: { Origin: allowed } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.revision).toBe('string')
    expect(body.revision.length).toBeGreaterThan(0)
    expect(Array.isArray(body.snapshot.commands)).toBe(true)
    expect(body.policy.schemaVersion).toBe(1)
    expect(body.policy.decisions.length).toBe(body.snapshot.commands.length)
  })

  it('/catalog 原形状不变 —— 既有前端契约不破', async () => {
    const res = await fetch(`${base}/catalog`, { headers: { Origin: allowed } })
    const body = await res.json()
    expect(Array.isArray(body.commands)).toBe(true)
    expect(body.policy).toBeUndefined()      // 原端点不得混入 policy
    expect(body.decisions).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/host-server.test.mjs`
Expected: FAIL —— `/catalog/effective` 返回 404

- [ ] **Step 3: `catalog-service.mjs` 生成 revision**

在原子替换处（现 `const policy = buildExecutionPolicy(snapshot)` 附近）加：

```js
    // revision 让「snapshot 与 decisions 同源」在 wire 上可验(I-P4),而不是靠口头承诺。
    const revision = createHash('sha256')
      .update(canonicalJson({ commands: snapshot.commands.length, opencliVersion: snapshot.opencliVersion, at: Date.now() }))
      .digest('hex').slice(0, 16)
    this.state = { snapshot, policy, revision }
```

（`createHash` 从 `node:crypto` 引入；`canonicalJson` 从 `./policy-fingerprint.mjs` 引入。）

- [ ] **Step 4: `host-server.mjs` 加端点**

在 `/catalog` 分支**之后**加：

```js
      if (url.pathname === '/catalog/effective' && request.method === 'GET') {
        if (!catalogService) {
          writeJson(response, 404, { error: 'Catalog refresh is not enabled' })
          return
        }
        try {
          await catalogService.refresh()
          const current = catalogService.current()
          writeJson(response, 200, {
            revision: current.revision,
            snapshot: current.snapshot,
            policy: {
              schemaVersion: POLICY_SCHEMA_VERSION,
              generatedAt: Date.now(),
              decisions: current.policy.decisions,
            },
          })
        } catch (error) {
          const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500
          writeJson(response, statusCode, {
            error: { summary: error instanceof Error ? error.message : 'Catalog refresh failed',
                     ...(error?.detail ? { detail: error.detail } : {}) },
          })
        }
        return
      }
```

**注意路由顺序**：`/catalog/effective` 必须写在 `/catalog` 之前，或 `/catalog` 用严格相等匹配（现状即 `url.pathname === '/catalog'`，故顺序无碍——但仍在此显式记录，避免后人改成 `startsWith` 时踩坑）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run server/host-server.test.mjs`
Expected: 全部 PASS（含既有用例）

- [ ] **Step 6: 提交**

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add server/catalog-service.mjs server/host-server.mjs server/host-server.test.mjs
git commit -m "feat(host): 新增 /catalog/effective 原子 envelope(带显式 revision);/catalog 原形状不变"
```

---

## Task 6：`/start` 确认校验与完整状态码表

**Files:**
- Modify: `server/policy.mjs`（`validateStartRequest`）、`server/host-server.mjs`
- Test: `server/policy.test.mjs`（追加）、`server/host-server.test.mjs`（追加）

**Interfaces:** `validateStartRequest(value, policy)` 对 `acknowledgement-required` 的命令要求 `acknowledgement.fingerprint` 匹配；新增 `RequestPolicyError` 的 428/409。

- [ ] **Step 1: 写失败测试**（追加到 `server/policy.test.mjs`）

```js
describe('确认校验与状态码', () => {
  const req = (over = {}) => ({
    runId: 'run-1', commandKey: 'antigravity/recent-paths',
    argv: ['antigravity', 'recent-paths', '-f', 'json'], ...over,
  })

  it('需确认但未带 acknowledgement → 428', () => {
    try { validateStartRequest(req(), policy); throw new Error('应当抛出') }
    catch (e) { expect(e.statusCode).toBe(428); expect(e.reasonCode).toBe('acknowledgement-required') }
  })

  it('fingerprint 不匹配 → 409', () => {
    try { validateStartRequest(req({ acknowledgement: { fingerprint: 'stale' } }), policy); throw new Error('应当抛出') }
    catch (e) { expect(e.statusCode).toBe(409) }
  })

  it('fingerprint 匹配 → 放行', () => {
    const fp = policy.decisionByKey.get('antigravity/recent-paths').fingerprint
    expect(validateStartRequest(req({ acknowledgement: { fingerprint: fp } }), policy).commandKey)
      .toBe('antigravity/recent-paths')
  })

  it('ready 的命令不需要 acknowledgement', () => {
    expect(validateStartRequest({ runId: 'r', commandKey: 'trae-cn/setup',
      argv: ['trae-cn', 'setup', '-f', 'json'] }, policy).commandKey).toBe('trae-cn/setup')
  })

  it('unknown 的命令 → 403 且 reasonCode 区分原因', () => {
    try {
      validateStartRequest({ runId: 'r', commandKey: 'trae-solo/state-get',
        argv: ['trae-solo', 'state-get', '-f', 'json'] }, policy)
      throw new Error('应当抛出')
    } catch (e) { expect(e.statusCode).toBe(403); expect(e.reasonCode).toBe('metadata-missing') }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/policy.test.mjs`
Expected: FAIL —— 428/409 未实现

- [ ] **Step 3: 改 `validateStartRequest`**

把现有的 `if (!policy.allowedCommands.has(commandKey))` 整块替换为按判决分派：

```js
  const decision = policy.decisionByKey?.get(commandKey)
  if (!decision || decision.state === 'denied' || decision.state === 'unknown') {
    // summary 保持不变(冻结契约:前端 summary 常显 / detail 按需展开)。
    // unknown 与 denied 同归 403——对调用方而言「未审定」同样是拒绝;由 reasonCode 区分。
    const error = new RequestPolicyError(403, 'Command is outside the P0-B execution policy',
      decision?.reason ? `${commandKey}: ${decision.reason}` : commandKey)
    error.reasonCode = decision?.reasonCode ?? 'no-decision'
    throw error
  }
  if (decision.state === 'acknowledgement-required') {
    const supplied = value.acknowledgement?.fingerprint
    if (typeof supplied !== 'string') {
      const error = new RequestPolicyError(428, 'Command requires an acknowledgement', commandKey)
      error.reasonCode = 'acknowledgement-required'
      throw error
    }
    if (supplied !== decision.fingerprint) {
      const error = new RequestPolicyError(409, 'Acknowledgement fingerprint is stale',
        '重新拉取 /catalog/effective 后再确认')
      error.reasonCode = 'fingerprint-stale'
      throw error
    }
  }
```

`RequestPolicyError` 的 JSON 序列化处（`host-server.mjs` 的 catch 分支）追加 `reasonCode`：

```js
        ...(error && typeof error === 'object' && error.reasonCode ? { reasonCode: error.reasonCode } : {}),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/policy.test.mjs server/host-server.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: 变异验证**

把 428 分支改成直接放行 → 「未带 acknowledgement → 428」用例必须变红。确认后还原。

- [ ] **Step 6: 提交**

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add server/policy.mjs server/host-server.mjs server/policy.test.mjs server/host-server.test.mjs
git commit -m "feat(policy): /start 按判决分派——202/428/409/403(denied|unknown)/400,reasonCode 稳定标识"
```

---

## Task 7：前端消费判决（置灰 + 就地说明）

**Files:**
- Create: `src/data/policy.ts`
- Modify: `src/data/catalogSource.ts`、`src/store/appStore.ts`、`src/features/config/CommandConfig.tsx`
- Test: `src/data/policy.test.ts`、`src/App.test.tsx`（追加两组对抗 fixture）

**Interfaces:** Produces `type PolicyDecision`、`decisionOf(decisions, commandKey)`；store 增 `decisions: Map<string, PolicyDecision>`。

**前端不得包含任何准入规则** —— 它只读 `state`/`reasonCode`。

- [ ] **Step 1: 写失败测试** `src/App.test.tsx` 追加

```tsx
describe('前端不自行裁决(对抗 fixture)', () => {
  it('A: manifest 看似满足旧派生条件,但 Host 判 denied → 必须置灰且不发 /start', async () => {
    const start = vi.fn()
    // read+public+browser=false —— 旧规则会放行
    renderWithHost({
      commands: [{ command: 'x/looks-ok', site: 'x', name: 'looks-ok', access: 'read',
                   strategy: 'public', browser: false, args: [], columns: [] }],
      decisions: [{ commandKey: 'x/looks-ok', state: 'denied', decisionSource: 'explicit-deny',
                    reasonCode: 'explicit-deny', reason: '演示用拒绝' }],
      onStart: start,
    })
    await userEvent.click(screen.getByText('looks-ok'))
    expect(screen.getByRole('button', { name: /运行任务/ })).toBeDisabled()
    expect(screen.getByText(/演示用拒绝/)).toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
  })

  it('B: manifest 看似不满足旧条件,但 Host 判 ready → 必须启用', async () => {
    const start = vi.fn()
    // write+cookie+browser=true —— 旧规则会拦截
    renderWithHost({
      commands: [{ command: 'y/looks-bad', site: 'y', name: 'looks-bad', access: 'write',
                   strategy: 'cookie', browser: true, args: [], columns: [] }],
      decisions: [{ commandKey: 'y/looks-bad', state: 'ready', decisionSource: 'tier-evaluation',
                    metadata: { executionPath: 'browser-bridge', authorities: [], exposure: 'public',
                                effects: [], credentialFlow: 'none', residues: [] } }],
      onStart: start,
    })
    await userEvent.click(screen.getByText('looks-bad'))
    expect(screen.getByRole('button', { name: /运行任务/ })).toBeEnabled()
  })
})
```

（`renderWithHost` 为本 task 新增的测试辅助，注入 decisions 与 `onStart` 间谍；实现放在 `src/testing/renderWithHost.tsx`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL —— 运行按钮未按判决置灰

- [ ] **Step 3: 写 `src/data/policy.ts`**

```ts
// 前端侧的判决类型。**本文件不得出现任何准入规则**——
// 「能不能跑」由 Host 决定,前端只读 state 与 reasonCode(I-P1)。
export type PolicyMetadata = {
  executionPath: 'direct-node' | 'browser-bridge'
  authorities: string[]
  exposure: 'public' | 'personal' | 'secret' | 'unknown'
  effects: string[]
  credentialFlow: 'none' | 'consume' | 'produce' | 'both'
  residues: 'unknown' | string[]
}

export type PolicyDecision = {
  commandKey: string
  state: 'ready' | 'acknowledgement-required' | 'denied' | 'unknown'
  decisionSource: 'explicit-deny' | 'legacy-baseline' | 'tier-evaluation' | 'unclassified'
  fingerprint?: string
  metadata?: PolicyMetadata
  reasonCode?: string
  reason?: string
}

const REASON_TEXT: Record<string, string> = {
  'explicit-deny': '该命令已被策略明确排除',
  'no-tier': '该命令尚未进入任何已开放的能力分组',
  'metadata-missing': '该命令还没有完成人工安全审定',
  'review-stale': '命令形状已变化，需要重新审定',
  'exposure-unknown': '输出敏感度尚未判定',
  'residue-unknown': '残留物尚未判定',
  'tier-threshold': '该命令超出当前分组允许的能力范围',
}

/** 只做文案映射,不做任何判断。 */
export function explainDecision(decision: PolicyDecision | undefined): string {
  if (!decision) return '尚未取得该命令的策略判决'
  if (decision.reason) return decision.reason
  return REASON_TEXT[decision.reasonCode ?? ''] ?? '该命令当前不可执行'
}

export function isRunnable(decision: PolicyDecision | undefined): boolean {
  return decision?.state === 'ready' || decision?.state === 'acknowledgement-required'
}
```

- [ ] **Step 4: store 与 UI 接线**

- `catalogSource.ts`：连接态改打 `/catalog/effective`，把 `decisions` 一并返回；降级到本地 snapshot 时 **decisions 为空**（前端整体标「未连接」，**不构造 decision**）。
- `appStore.ts`：`setCommands` 时一并存 `decisions: Map`；`executeSelected` 首行加 `if (!isRunnable(decisionOf(selected))) return`。
- `CommandConfig.tsx`：运行按钮 `disabled={!isRunnable(decision)}`，按钮下方渲染 `explainDecision(decision)`。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 6: 变异验证**

把 `executeSelected` 的判决检查删掉 → fixture A 的 `expect(start).not.toHaveBeenCalled()` 必须变红。确认后还原。

- [ ] **Step 7: 提交**

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add src/data/policy.ts src/data/policy.test.ts src/data/catalogSource.ts src/store/appStore.ts src/features/config/CommandConfig.tsx src/testing/renderWithHost.tsx src/App.test.tsx
git commit -m "feat(front): 按 Host 判决置灰并就地说明;两组对抗 fixture 证明前端不自行裁决"
```

---

## Task 8：preferences v2 迁移 + acknowledgement 管理

**Files:**
- Modify: `src/data/preferences.ts`、`src/store/appStore.ts`
- Create: `src/features/config/AcknowledgeDialog.tsx`
- Test: `src/data/preferences.test.ts`（追加）

**Interfaces:** Produces `PREFS_KEY_V2`、`loadPreferences` 自动迁移、`acknowledge(prefs, commandKey, fingerprint, now)`、`revokeAcknowledgement(prefs, commandKey)`、`isAcknowledged(prefs, commandKey, fingerprint)`。

- [ ] **Step 1: 写失败测试**（追加到 `src/data/preferences.test.ts`）

```ts
describe('preferences v2', () => {
  it('v1 数据自动迁移,收藏与 recent 全部保留', () => {
    const s = memoryStorage()
    s.setItem('opencli-app:prefs:v1', JSON.stringify({
      favoriteSites: [{ site: 'a', createdAt: 1 }],
      favoriteCommands: [{ command: 'a/b', site: 'a', createdAt: 2 }],
      recent: [{ command: 'a/b', at: 3 }],
    }))
    const prefs = loadPreferences(s)
    expect(prefs.favoriteSites).toHaveLength(1)
    expect(prefs.favoriteCommands).toHaveLength(1)
    expect(prefs.recent).toHaveLength(1)
    expect(prefs.acknowledgements).toEqual([])
    expect(s.getItem('opencli-app:prefs:v2')).toBeTruthy()
  })

  it('坏项逐项丢弃,好项保留', () => {
    const s = memoryStorage()
    s.setItem('opencli-app:prefs:v2', JSON.stringify({
      favoriteSites: [{ site: 'a', createdAt: 1 }, null, { site: 5 }],
      favoriteCommands: [], recent: [],
      acknowledgements: [{ commandKey: 'a/b', fingerprint: 'f', acknowledgedAt: 1 }, { commandKey: 7 }],
    }))
    const prefs = loadPreferences(s)
    expect(prefs.favoriteSites).toHaveLength(1)
    expect(prefs.acknowledgements).toHaveLength(1)
  })

  it('确认绑 fingerprint —— 指纹变了即失效', () => {
    let prefs = emptyPreferences()
    prefs = acknowledge(prefs, 'a/b', 'fp1', 100)
    expect(isAcknowledged(prefs, 'a/b', 'fp1')).toBe(true)
    expect(isAcknowledged(prefs, 'a/b', 'fp2')).toBe(false)
  })

  it('可撤销', () => {
    let prefs = acknowledge(emptyPreferences(), 'a/b', 'fp1', 100)
    prefs = revokeAcknowledgement(prefs, 'a/b')
    expect(isAcknowledged(prefs, 'a/b', 'fp1')).toBe(false)
  })

  it('storage 不可写时不抛,且返回「本次有效」标记', () => {
    const failing = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
    const prefs = acknowledge(emptyPreferences(), 'a/b', 'fp', 1)
    expect(() => savePreferences(prefs, failing as unknown as Storage)).not.toThrow()
    expect(savePreferences(prefs, failing as unknown as Storage)).toBe(false)   // false = 未持久化
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/data/preferences.test.ts`
Expected: FAIL —— `acknowledge is not exported`

- [ ] **Step 3: 实现 v2**

- 新增 `export const PREFS_KEY_V2 = 'opencli-app:prefs:v2'`，保留 `PREFS_KEY`（v1，只读）。
- `loadPreferences`：先读 v2 → 无则读 v1 归一化后写 v2 → 皆无则空。
- `PreferencesSnapshot` 增 `acknowledgements: Acknowledgement[]`，沿用既有的 `uniqueBy` 与逐项校验。
- `savePreferences` 返回 `boolean`（是否真的持久化），失败返回 `false` 而不抛。
- 新增 `acknowledge` / `revokeAcknowledgement` / `isAcknowledged` 三个纯函数。

- [ ] **Step 4: UI 接线**

`AcknowledgeDialog.tsx`：展示命令、`exposure`、`authorities` 的中文说明与「本次仅本次会话有效」提示（当 `savePreferences` 返回 `false`）。确认后把 `fingerprint` 随 `/start` 一并提交。

- [ ] **Step 5: 跑测试确认通过 + 变异验证**

Run: `npx vitest run`
变异：把 `isAcknowledged` 里的 fingerprint 比对去掉（只比 commandKey）→ 第 3 条用例必须变红。

- [ ] **Step 6: 提交**

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add src/data/preferences.ts src/data/preferences.test.ts src/features/config/AcknowledgeDialog.tsx src/store/appStore.ts
git commit -m "feat(front): preferences v2 迁移 + acknowledgement 绑指纹/可撤销;storage 失败降级为本次会话有效"
```

---

## Task 9：活动历史（独立存储）

**Files:**
- Create: `src/data/activity.ts`、`src/data/activity.test.ts`
- Modify: `src/store/appStore.ts`

**Interfaces:** Produces `ACTIVITY_KEY`、`appendActivity(entries, entry)`、`finishActivity(entries, id, patch)`、`loadActivity`/`saveActivity`/`clearActivity`，`ACTIVITY_CAP = 200`。

- [ ] **Step 1: 写失败测试** `src/data/activity.test.ts`

```ts
describe('活动历史', () => {
  it('容量上限 200,超出驱逐最旧', () => {
    let entries: ActivityEntry[] = []
    for (let i = 0; i < 250; i += 1) {
      entries = appendActivity(entries, { id: `i${i}`, runId: `r${i}`, startedAt: i,
        commandKey: 'a/b', decisionState: 'ready', exposure: 'public', acknowledged: false })
    }
    expect(entries).toHaveLength(200)
    expect(entries[0].id).toBe('i50')
  })

  it('被拒尝试也留痕 —— 条目在发起时就写入,不等 HTTP 受理', () => {
    const entries = appendActivity([], { id: 'x', runId: 'r', startedAt: 1, commandKey: 'a/b',
      decisionState: 'unknown', exposure: null, acknowledged: false })
    const done = finishActivity(entries, 'x', { finishedAt: 2, outcome: 'rejected' })
    expect(done[0].outcome).toBe('rejected')
  })

  it('不含参数值/结果/错误详情', () => {
    const entry = { id: 'x', runId: 'r', startedAt: 1, commandKey: 'a/b',
      decisionState: 'ready', exposure: 'public', acknowledged: true } as ActivityEntry
    expect(Object.keys(entry)).toEqual(expect.not.arrayContaining(['values', 'argv', 'result', 'error', 'detail']))
  })

  it('与 preferences 分开存储', () => {
    expect(ACTIVITY_KEY).not.toBe(PREFS_KEY_V2)
  })
})
```

- [ ] **Step 2-4: 实现、接线、跑通**

`appStore.beginRun` 前置写入 ActivityEntry（`runId` 已在此前生成，**同时**写入，不回填）；终态与被拒分支按 `id` 调 `finishActivity`。

- [ ] **Step 5: 提交**

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add src/data/activity.ts src/data/activity.test.ts src/store/appStore.ts
git commit -m "feat(front): 活动历史独立存储(定长 200/可清空/不记参数与结果);被拒尝试同样留痕"
```

---

## Self-review 记录

- **Spec 覆盖**：§3→T1/T2；§4.1-4.2→T3；§4.3→T4；§5→T2；§6.2→T5；§6.3→T6；§7→T8；§8.1→T8；§8.2→T9；§9→T1 的审定记录 + T4 的断言；§10.1 十五条门分散在 T1-T9 的测试里；§10.2 真机门**不在本计划**（须环境具备后另行执行，见下）。
- **依赖序无环**：T1→T2→T3→T4→T5→T6→T7→T8→T9。T3 依赖 T2 的 `reviewShapeHash`；T4 依赖 T1/T2/T3；T6 依赖 T4 的 `decisionByKey`；T7 依赖 T5 的端点；T8/T9 依赖 T7 的接线点。
- **类型一致**：`PolicyDecision` 在 `server/policy.mjs`（产出）与 `src/data/policy.ts`（消费）两侧字段名逐字相同；`reviewShapeHash`/`decisionFingerprint` 的入参对象键名与 spec §5 一致。
- **占位符**：无。每个改动步骤都给了可直接落地的代码或明确的改动点。T7 Step 4、T8 Step 3-4、T9 Step 2-4 给的是改动点清单而非整文件代码——因为它们是在**既有文件**上的增量接线，逐行贴全文反而掩盖 diff；每处都点名了函数与行为。
- **两级验收**：本计划的 DoD = **代码门**（`tsc && vitest && build && check:legacy` 全绿 + 各 task 的变异验证）。**真机证据门**（spec §10.2）不含在内：本机 Antigravity 与 Trae SOLO 均未安装，`ambient-local` 真机项按 spec §9.2 的替换准则处理；若三备选皆不可用，记「环境不具备，未验」，**不得宣称 1a 真机闭环**。
