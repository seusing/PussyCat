# P0-A 修正计划（接 P0-B 前必修）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 修掉独立 review + 真实 catalog 核实暴露的 P0-A 缺口（argv/预览错误、契约不足承接 P0-B、错误收口缺失、seq/脱敏），使 P0-A 真正可关闭并安全接真实 Node Host。

**Architecture:** 在已完成的 P0-A（main HEAD `1c47de1`）上做修正。核心是把 argv 变成**唯一执行事实源**（App 单点 `buildTokens`/`buildArgv`），HostBridge 契约升级为 `{commandKey, argv}`，并补齐 start/cancel/catalog 三处错误收口 + seq 去重 + 脱敏收紧。

**Tech Stack:** 同 P0-A（Vite/React/TS/Tailwind/Zustand/Vitest）。设计依据：deep-reasoner 修正设计（bool 惯例已从 opencli CLI 源码查实）。

## Global Constraints

- 基线 main HEAD `1c47de1`；本计划在新分支 `p0-a-fix` 上做。
- **bool CLI 惯例（源码实证，勿再猜）**：opencli 用 Commander `--name [value]` 可选值式，bool 无特例。关闭一个 `default=true` 的 bool 的正确 argv 是 **`--flag false`**（值式）；`--no-flag` 会报未知选项。证据：`AppData/Roaming/npm/node_modules/@jackwener/opencli/dist/src/commanderAdapter.js` + `execution.js`。
- **argv 唯一事实源**：App 单点用 `buildTokens`/`buildArgv` 构 argv；preview 与 `RunRequest.argv` 同源，杜绝前后端漂移。
- **真实 catalog fuzz 验证纳入验收门**：涉 catalog 数据行为的 task（bool/positional/脱敏），验收 step 必须用 node 跑真实 `public/catalog.snapshot.json` 坐实修复 + 无新误伤。
- 复用现有 `runMachine.transition`，**不加新状态/新 action**（除必要的 store 字段）。
- TDD；commit 中文标题，结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 每个 task 结束：`npx tsc --noEmit` clean + 全量 `npm test` 无回归。

---

### Task 1: argv / preview 正确性（bool 值式 + positional 拦 + token 化）

**Files:**
- Modify: `src/data/command.ts`（加 `ArgToken`/`buildTokens`，`buildArgv` 派生，`commandPreview` token 化，bool 值式）
- Modify: `src/features/config/validation.ts`（positional-gap 拦截）
- Test: `src/data/command.test.ts`、`src/features/config/validation.test.ts`

**Interfaces:**
- Produces: `type ArgToken = { kind: 'sub'|'flag'|'value'; text: string }`；`buildTokens(cmd, values): ArgToken[]`；`buildArgv(cmd, values): string[]`（= tokens.map(t=>t.text)）；`commandPreview(cmd, values): string`。

- [ ] **Step 1: 改/补 `command.test.ts`（暴露 bool + preview bug）**

```ts
// 改现有断言：bool true 现在发对称显式值
test('buildArgv：布尔 true 发 --flag true，false 且无默认省略', () => {
  const c = cmd([{ name: 'images-only', type: 'boolean' }])
  expect(buildArgv(c, { 'images-only': true })).toEqual(['xiaohongshu', 'download', '--images-only', 'true'])
  expect(buildArgv(c, { 'images-only': false })).toEqual(['xiaohongshu', 'download'])
})
// 新增：default=true 关闭 → --flag false（核心 bug）
test('buildArgv：default=true 的布尔被关闭 → --flag false（非省略）', () => {
  const c = cmd([{ name: 'wait', type: 'boolean', default: true }])
  expect(buildArgv(c, { wait: false })).toEqual(['xiaohongshu', 'download', '--wait', 'false'])
  expect(buildArgv(c, { wait: true })).toEqual(['xiaohongshu', 'download']) // 与默认同 → 省略
})
// 新增：preview token 边界（值以 -- 开头不被误当 flag）
test('commandPreview：值以 -- 开头仍加引号，不误判为 flag', () => {
  const c = cmd([{ name: 'out', type: 'str' }])
  expect(commandPreview(c, { out: '--foo bar' })).toBe('opencli xiaohongshu download --out "--foo bar"')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/data/command.test.ts`
Expected: FAIL（bool 省略、preview 用 startsWith 误判）

- [ ] **Step 3: 重写 `src/data/command.ts`**

```ts
import type { CommandManifest, ManifestArg } from './types'

export type ArgToken = { kind: 'sub' | 'flag' | 'value'; text: string }

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === ''
}
function isBool(a: ManifestArg): boolean {
  return a.type === 'bool' || a.type === 'boolean'
}
function boolDefault(a: ManifestArg): boolean {
  return a.default === true || a.default === 'true'
}

export function buildTokens(cmd: CommandManifest, values: Record<string, unknown>): ArgToken[] {
  const toks: ArgToken[] = [
    { kind: 'sub', text: cmd.site },
    { kind: 'sub', text: cmd.name },
  ]
  const positional = cmd.args.filter((a) => a.positional)
  const flags = cmd.args.filter((a) => !a.positional)

  // positional：按声明顺序，非 bool，空则跳过（validation 已拦"中空+后有值"）
  for (const a of positional) {
    if (isBool(a)) continue
    if (!isEmpty(values[a.name])) toks.push({ kind: 'value', text: String(values[a.name]) })
  }
  // flags
  for (const a of flags) {
    if (isBool(a)) {
      const desired = values[a.name] === true
      if (desired !== boolDefault(a)) {
        toks.push({ kind: 'flag', text: `--${a.name}` })
        toks.push({ kind: 'value', text: String(desired) })   // 显式 true|false
      }
      continue
    }
    if (isEmpty(values[a.name])) continue
    toks.push({ kind: 'flag', text: `--${a.name}` })
    toks.push({ kind: 'value', text: String(values[a.name]) })
  }
  return toks
}

export function buildArgv(cmd: CommandManifest, values: Record<string, unknown>): string[] {
  return buildTokens(cmd, values).map((t) => t.text)
}

function quote(s: string): string {
  return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

export function commandPreview(cmd: CommandManifest, values: Record<string, unknown>): string {
  const toks = buildTokens(cmd, values)
  const body = toks.map((t) => (t.kind === 'flag' ? t.text : quote(t.text))).join(' ')
  return `opencli ${body}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/data/command.test.ts`
Expected: 全 passed

- [ ] **Step 5: 补 `validation.test.ts`（positional-gap）**

```ts
test('validate：位置参数中间空、后面有值 → 报错（不可跳过）', () => {
  const c: CommandManifest = {
    command: 'xianyu/messages', site: 'xianyu', name: 'messages', description: '', access: 'read', browser: false,
    args: [
      { name: 'item_id', type: 'str', positional: true },
      { name: 'user_id', type: 'str', positional: true },
    ],
  }
  expect(validate(c, { user_id: 'u1' })).toEqual({ item_id: '位置参数不能跳过：填了后面的就必须先填它' })
  expect(validate(c, { item_id: 'i1', user_id: 'u1' })).toEqual({})
  expect(validate(c, {})).toEqual({})
})
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npx vitest run src/features/config/validation.test.ts`
Expected: FAIL

- [ ] **Step 7: `src/features/config/validation.ts` 加 positional-gap 拦截**

在现有 `validate` 的字段循环后追加（保留原有 required/number 校验）：

```ts
  const pos = cmd.args.filter((a) => a.positional)
  for (let i = 0; i < pos.length; i++) {
    const empty = (v: unknown) => v === undefined || v === null || v === ''
    if (empty(values[pos[i].name]) && pos.slice(i + 1).some((p) => !empty(values[p.name]))) {
      errors[pos[i].name] = '位置参数不能跳过：填了后面的就必须先填它'
    }
  }
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run src/features/config/`
Expected: 全 passed

- [ ] **Step 9: 真实 catalog fuzz 验证（新验收门）**

Run:
```bash
node -e "
const s=require('./public/catalog.snapshot.json');
const {buildArgv}=await import('./src/data/command.ts');
// 12 个 bool default=true：关闭必须出现 --flag false
let bad=0;
s.commands.forEach(c=>(c.args||[]).forEach(a=>{
  if((a.type==='bool'||a.type==='boolean')&&(a.default===true||a.default==='true')){
    const argv=buildArgv(c,{[a.name]:false});
    const i=argv.indexOf('--'+a.name);
    if(!(i>=0 && argv[i+1]==='false')){ bad++; console.log('MISS', c.command, a.name, argv.join(' ')); }
  }
}));
console.log(bad===0?'PASS: 全部 default=true bool 关闭都产出 --flag false':'FAIL '+bad);
" --input-type=module
```
Expected: `PASS: 全部 default=true bool 关闭都产出 --flag false`
（若 Node 直载 .ts 不便，可临时 `npx tsx` 或在一次性 vitest 用例里跑同逻辑；关键是**用真实 catalog 遍历坐实**，不是抽样。）

- [ ] **Step 10: Commit**

```bash
git add src/data/command.ts src/data/command.test.ts src/features/config/validation.ts src/features/config/validation.test.ts
git commit -m "fix(command): bool 值式(--flag false)+positional 跳过拦截+preview token 化"
```

---

### Task 2: HostBridge 契约升级（RunRequest → commandKey + argv）

**Files:**
- Modify: `src/host/types.ts`（`RunRequest`）
- Modify: `src/host/mockHost.ts`（消费 `commandKey`/`argv`）
- Modify: `src/App.tsx`（onRun 构 argv 发新型）
- Test: `src/host/mockHost.test.ts`（8 处调用点）

**Interfaces:**
- Consumes: `buildArgv`（Task 1）。
- Produces: `RunRequest = { runId, commandKey, argv, format?, mockScenario? }`。

- [ ] **Step 1: 改 `src/host/types.ts` 的 RunRequest**

```ts
export type RunRequest = {
  runId: string
  commandKey: string          // "site/name"，list 主键
  argv: string[]              // buildArgv 产物（[site, name, ...]），唯一执行事实源
  format?: OutputFormat
  mockScenario?: 'success' | 'error'
}
```

- [ ] **Step 2: 改 `src/host/mockHost.test.ts` 的 8 个调用点 + 跑确认失败**

把每处 `startCommand({ runId: 'r1', site: 'x', command: 'c', args: {} })` 改为
`startCommand({ runId: 'r1', commandKey: 'x/c', argv: ['x', 'c'] })`（error 场景保留 `mockScenario: 'error'`）。契约语义断言不变。
Run: `npx vitest run src/host/mockHost.test.ts` → 先因 mockHost 仍读 `req.site/req.command` 而 FAIL（或 tsc 报错）。

- [ ] **Step 3: 改 `src/host/mockHost.ts` 消费新字段**

`startCommand` 内：`emit(req.runId, run, 'stdout', `启动 ${req.commandKey}`)`（原 `${req.site} ${req.command}`）；success result 用 `{ status: 'ok', site: req.commandKey.split('/')[0] }`。其余不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/host/mockHost.test.ts`
Expected: 8/8 passed

- [ ] **Step 5: 改 `src/App.tsx` 的 onRun 构 argv**

```ts
import { buildArgv } from './data/command'
// onRun：
const onRun = () => {
  const s = useAppStore.getState()
  if (!s.selected) return
  const runId = `run-${++runSeq}`
  s.beginRun(runId)
  const argv = buildArgv(s.selected, s.values)
  void host.startCommand({ runId, commandKey: s.selected.command, argv }) // .catch 在 Task 4 补
}
```

- [ ] **Step 6: 跑全量 + tsc**

Run: `npx tsc --noEmit` → clean；`npm test` → 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/host/types.ts src/host/mockHost.ts src/host/mockHost.test.ts src/App.tsx
git commit -m "feat(host): RunRequest 升级 commandKey+argv(唯一执行事实源)"
```

---

### Task 3: store 层收口（seq 去重/终态守卫 + catalog 态 + 脱敏收紧）

**Files:**
- Modify: `src/store/appStore.ts`（`appendOutput` seq 去重/有序/终态守卫、`finishRun` 终态守卫、`catalogStatus`/`catalogError` 字段 + setter、`redactValues` 正则）
- Test: `src/store/appStore.test.ts`

**Interfaces:**
- Produces: store 增 `catalogStatus: 'loading'|'ready'|'error'`、`catalogError?: string`、`setCatalogStatus`；`appendOutput` 幂等有序；`finishRun` 终态后幂等。

- [ ] **Step 1: 补 `appStore.test.ts`（seq/终态/脱敏/catalog 态）**

```ts
test('appendOutput：按 seq 去重且乱序插入有序', () => {
  useAppStore.getState().selectCommand(cmd); useAppStore.getState().beginRun('r1')
  const ev = (seq: number, text: string) => ({ runId: 'r1', seq, at: 1, stream: 'stdout' as const, text })
  useAppStore.getState().appendOutput(ev(1, 'b'))
  useAppStore.getState().appendOutput(ev(0, 'a'))
  useAppStore.getState().appendOutput(ev(1, 'b-dup'))   // 重复 seq → 丢弃
  const lines = useAppStore.getState().currentRun!.lines
  expect(lines.map((l) => l.seq)).toEqual([0, 1])
  expect(lines.map((l) => l.text)).toEqual(['a', 'b'])
})
test('appendOutput：终态后到达的 output 被抑制', () => {
  useAppStore.getState().selectCommand(cmd); useAppStore.getState().beginRun('r1')
  useAppStore.getState().finishRun({ runId: 'r1', at: 2, outcome: 'success' })
  useAppStore.getState().appendOutput({ runId: 'r1', seq: 0, at: 3, stream: 'stdout', text: 'late' })
  expect(useAppStore.getState().currentRun!.lines).toHaveLength(0)
})
test('finishRun：终态后重复 done 幂等（不覆盖）', () => {
  useAppStore.getState().selectCommand(cmd); useAppStore.getState().beginRun('r1')
  useAppStore.getState().finishRun({ runId: 'r1', at: 2, outcome: 'success' })
  useAppStore.getState().finishRun({ runId: 'r1', at: 3, outcome: 'error', error: { summary: 'x' } })
  expect(useAppStore.getState().currentRun!.state).toBe('succeeded')
  expect(useAppStore.getState().currentRun!.error).toBeUndefined()
})
test('redactValues：脱真敏感、保留 keyword/key', () => {
  const c = { ...cmd, args: [{ name: 'password', type: 'str' }, { name: 'keyword', type: 'str' }, { name: 'key', type: 'str' }] }
  const out = redactValues(c, { password: 'p', keyword: '茅台', key: 'PROJ-1' })
  expect(out.password).toBe('••••'); expect(out.keyword).toBe('茅台'); expect(out.key).toBe('PROJ-1')
})
test('catalogStatus 默认 loading，setCatalogStatus 可切', () => {
  expect(useAppStore.getState().catalogStatus).toBe('loading')
  useAppStore.getState().setCatalogStatus('error', '404')
  expect(useAppStore.getState().catalogStatus).toBe('error')
  expect(useAppStore.getState().catalogError).toBe('404')
})
```

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run src/store/appStore.test.ts` → FAIL

- [ ] **Step 3: 改 `src/store/appStore.ts`**

- `SENSITIVE` 正则改为：`const SENSITIVE = /password|passcode|secret|token|cookie/i`（删 `key`、裸 `pass`；`token` 子串覆盖 `stoken`）。
- 加 `isTerminal(s: RunState)`：`s==='succeeded'||s==='failed'||s==='cancelled'`。
- `appendOutput`：若无 currentRun 或 id 不符或 `isTerminal(state)` → 返回原样（终态守卫）；否则若 `lines.some(l=>l.seq===e.seq)` → 丢弃（去重）；否则插入并按 `seq` 升序排序。
- `finishRun`：若 `isTerminal(currentRun.state)` → 返回原样（终态幂等守卫）；否则照原逻辑。
- 加字段：`catalogStatus: 'loading'|'ready'|'error'`（初值 `'loading'`）、`catalogError?: string`、`setCatalogStatus(status, error?)`。
- `setCommands` 顺带把 `catalogStatus` 设 `'ready'`（或由 App 显式调 setCatalogStatus）。

（`appendOutput` 有序插入示例）
```ts
appendOutput: (e) => set((s) => {
  if (!s.currentRun || s.currentRun.id !== e.runId || isTerminal(s.currentRun.state)) return s
  if (s.currentRun.lines.some((l) => l.seq === e.seq)) return s
  const lines = [...s.currentRun.lines, e].sort((a, b) => a.seq - b.seq)
  return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'OUTPUT' }), lines } }
}),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/store/appStore.test.ts`
Expected: 全 passed

- [ ] **Step 5: 真实 catalog fuzz 验证（脱敏，新验收门）**

Run:
```bash
node -e "
const s=require('./public/catalog.snapshot.json');
const SENS=/password|passcode|secret|token|cookie/i;
const names=new Set(); s.commands.forEach(c=>(c.args||[]).forEach(a=>names.add(a.name)));
const masked=[...names].filter(n=>SENS.test(n)).sort();
const keptSensitiveRisk=[...names].filter(n=>/password|passcode|token|secret|cookie/i.test(n)).sort();
console.log('会脱敏的参数名:', masked.join(', '));
console.log('keyword 保留:', !SENS.test('keyword'), '| key 保留:', !SENS.test('key'), '| keywords 保留:', !SENS.test('keywords'));
"
```
Expected: 脱敏名仅含 password/passcode/token/stoken/secret/cookie 类；`keyword 保留: true | key 保留: true | keywords 保留: true`

- [ ] **Step 6: 跑全量 + Commit**

Run: `npx tsc --noEmit` clean；`npm test` 全绿。
```bash
git add src/store/appStore.ts src/store/appStore.test.ts
git commit -m "fix(store): seq 去重+终态守卫+catalog 三态+脱敏正则收紧(保住 keyword)"
```

---

### Task 4: App/UI 层收口（错误收口 + catalog 三态 + 表单清除 + ×收起 + 集成测试）

**Files:**
- Modify: `src/App.tsx`（onRun/onCancel `.catch`→finishRun、loadCatalog 三态+重试、`normalizeHostError`）
- Modify: `src/data/catalog.ts`（`assertSnapshot` 运行时 schema 校验）
- Modify: `src/features/config/CommandConfig.tsx`（切命令清 errors）
- Modify: `src/features/runs/RunPanel.tsx` + `src/components/AppShell.tsx`（catalog loading/error 渲染、× 收起）
- Test: `src/features/runs/RunPanel.test.tsx`（集成：三终态 + 错误路径 + catalog 态）

**Interfaces:**
- Consumes: store 的 `catalogStatus`/`setCatalogStatus`/`finishRun`（Task 3）；`RunRequest`（Task 2）。

- [ ] **Step 1: 补集成/单元测试（暴露收口缺失）**

```ts
// App 集成：startCommand rejection → failed UI（注入会 reject 的 host）
// 依赖：App 支持可选 host prop（见 Step 4），默认 createMockHost，测试注入。
test('startCommand rejection → 已失败 + 错误摘要', async () => {
  const rejectingHost: HostBridge = {
    startCommand: () => Promise.reject(new Error('host 启动失败')),
    cancelCommand: () => Promise.resolve(),
    onOutput: () => () => {}, onDone: () => () => {},
  }
  useAppStore.setState({ commands: [cmd], selected: cmd, values: {}, currentRun: undefined })
  render(<App host={rejectingHost} />)
  await userEvent.click(screen.getByTestId('run-button'))
  await waitFor(() => expect(screen.getByTestId('run-state')).toHaveTextContent('失败'))
  expect(screen.getByText(/host 启动失败/)).toBeInTheDocument()
})
// catalog error 渲染 + 重试
test('catalog error 态渲染提示与重试按钮', () => {
  useAppStore.setState({ catalogStatus: 'error', catalogError: '加载失败：404' })
  render(<App />)
  expect(screen.getByText(/加载失败/)).toBeInTheDocument()
  expect(screen.getByTestId('catalog-retry')).toBeInTheDocument()
})
// CommandConfig 切命令清 errors
test('切换命令后旧字段错误不残留', async () => {
  useAppStore.setState({ selected: cmdA, values: {}, currentRun: undefined })
  render(<CommandConfig onRun={() => {}} />)
  await userEvent.click(screen.getByTestId('run-button'))          // 触发 cmdA 的 required 错误
  expect(screen.getByTestId('error-url')).toBeInTheDocument()
  useAppStore.getState().selectCommand(cmdB)                        // 切到 cmdB
  await waitFor(() => expect(screen.queryByTestId('error-url')).not.toBeInTheDocument())
})
```

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run src/features/` → FAIL

- [ ] **Step 3: 改 `src/data/catalog.ts` 加 `assertSnapshot`**

```ts
export class CatalogError extends Error {}
function assertSnapshot(x: unknown): CatalogSnapshot {
  const s = x as any
  if (s?.schemaVersion !== 1) throw new CatalogError(`schemaVersion 不支持：${s?.schemaVersion}`)
  if (!Array.isArray(s.commands)) throw new CatalogError('commands 非数组')
  for (const c of s.commands)
    if (!c.command || !c.site || !c.name || !('access' in c) || !Array.isArray(c.args))
      throw new CatalogError(`命令字段缺失：${c?.command ?? '?'}`)
  return s as CatalogSnapshot
}
export async function loadCatalog(): Promise<CatalogSnapshot> {
  const res = await fetch('/catalog.snapshot.json')
  if (!res.ok) throw new CatalogError(`加载 catalog 失败：${res.status}`)
  return assertSnapshot(await res.json())
}
```

- [ ] **Step 4: 改 `src/App.tsx`（可选 host prop + 错误收口 + catalog 三态）**

先让 App 支持注入 host（生产默认不变；测试注入 reject host 验证 start-rejection）：
```ts
export default function App({ host: injectedHost }: { host?: HostBridge } = {}) {
  const host = useMemo(() => injectedHost ?? createMockHost(), [injectedHost])
  // ...其余接线不变（onOutput/onDone 订阅、onRun、onCancel、loadCatalog）
}
```

错误收口 + catalog 三态：
```ts
const normalizeHostError = (e: unknown) => ({
  summary: e instanceof Error ? e.message : '任务启动失败',
  detail: e instanceof Error ? e.stack : String(e),
})
// onRun：startCommand(...).catch(err => useAppStore.getState().finishRun({ runId, at: Date.now(), outcome: 'error', error: normalizeHostError(err) }))
// onCancel：cancelCommand(run.id).catch(err => useAppStore.getState().finishRun({ runId: run.id, at: Date.now(), outcome: 'error', error: normalizeHostError(err) }))
// useEffect：loadCatalog().then(snap => { setCommands(snap.commands); setCatalogStatus('ready') })
//                        .catch(err => setCatalogStatus('error', err instanceof Error ? err.message : String(err)))
```
根据 `catalogStatus` 渲染：`error` → 错误提示 + `data-testid="catalog-retry"`（onClick 重跑 loadCatalog）；`loading` → 简单加载态；`ready` → 现有三栏。

- [ ] **Step 5: 改 `CommandConfig.tsx` 切命令清 errors**

```ts
useEffect(() => { setErrors({}) }, [selected])
```

- [ ] **Step 6: × 只收起（RunPanel + store 或本地 flag）**

给命令弹层/任务卡的 × 加 `panelCollapsed` 视图 flag（与 run.state 无关）：× 切 `panelCollapsed=true` 只隐藏面板视图，**不调 cancel、不改 run.state**；活动任务仍在 store。（P0-A 单面板下最小实现：RunPanel 顶部加一个 `×` `data-testid="collapse-panel"`，点击隐藏 body 保留状态条；显式"取消执行"才终止。）

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run src/features/`
Expected: 全 passed

- [ ] **Step 8: 全量 + tsc + Commit**

Run: `npx tsc --noEmit` clean；`npm test` 全绿。
```bash
git add src/App.tsx src/data/catalog.ts src/features/config/CommandConfig.tsx src/features/runs/RunPanel.tsx src/components/AppShell.tsx src/features/runs/RunPanel.test.tsx
git commit -m "fix(ui): start/cancel rejection→failed+catalog 三态重试+切命令清错+×只收起"
```

---

## 修正验收对照

| review 问题 | 对应 Task |
|---|---|
| ① RunRequest 无 argv | Task 2 |
| ② bool 默认值 / positional 前移 / preview token | Task 1 |
| ③ start/cancel rejection 卡死 + failed UI | Task 4 |
| ④ catalog 静默吞错 | Task 4（+ Task 3 store 态） |
| ⑤ seq 去重 + 终态守卫 | Task 3 |
| ⑥ 脱敏误伤 | Task 3 |
| ⑦a 切命令表单错误残留 | Task 4 |
| ⑦b × 只收起 | Task 4 |

## 下一阶段（不在本计划，P0-C）

⑦c 日志自动滚动、⑦d validating 可视/按钮态标签、⑦e 窄窗响应式（三栏→抽屉）、⑦f a11y（aria-live/label/table 语义）、dev-only「模拟失败」开关、cancel 超时看门狗。deep-reasoner 判定非验收阻塞，P0-A 修正（Task 1-4）过 whole-branch review 后可进 P0-B，这些随 P0-C 做。
