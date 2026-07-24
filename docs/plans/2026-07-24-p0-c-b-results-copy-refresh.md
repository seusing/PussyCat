# P0-C 块 B：结果·错误·复制·重跑·Catalog 真刷新 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 语境化复制三态 + 终态重跑（权威守卫）+ 错误详情展开 + Catalog 真刷新（服务端现场重生成 + policy 校验后原子更新 + 前端 CatalogSource 抽象）。

**Architecture:** 前端三层不变（纯函数 data/lib → store → UI）；新增 `CatalogSource` 抽象与 Host 共享 baseUrl；服务端新增 `CatalogService`（spawn→merge→校验→policy 构建全成功后原子替换 `{snapshot, policy}` 单引用），`/start` 改读动态 policy。冻结的 HostBridge 运行契约（`/start /cancel /events` 与 SSE 形状）零触碰。

**Tech Stack:** Vite 6 + React 18 + TS strict + Zustand 5 + Vitest（前端 jsdom / server node env）；server 纯 Node（≥23，type-stripping import `.ts` 已由 `scripts/sync-catalog.mjs` 实证；本机 25.7.0）。

**Spec:** `docs/specs/2026-07-24-p0-c-b-results-copy-refresh-design.md`（v2，含 §0 复审回执）。

## Global Constraints（每个 task 隐含包含）

- **HostBridge 冻结契约零触碰**：不改 `startCommand/cancelCommand/onOutput/onDone`、`/start /cancel /events` 语义与 SSE 事件形状、`runMachine.ts`、`currentRun` 单任务模型。
- **无新 argv 构造路径**：重跑走 `executeSelected` → 现有 `buildArgv`。
- **复制不碰脱敏**：复制命令取活表单 preview；结果/日志来自 run 事件流；`currentRun.values`（已脱敏）不参与复制。
- **服务端刷新安全**：spawn 参数全为服务端常量（entry + `'list' '-f' 'json'`），无任何请求输入参与；`shell:false` 绕 cmd.exe；15s 超时；8 MiB stdout 上限；single-flight；失败旧值不动。
- **状态码矩阵**：504 超时 / 502 spawn 失败·非零退出·输出超限 / 500 坏 JSON·schema 校验败·manifest 读取败。
- **复制文案与口径**：成功=「复制结构化结果」`JSON.stringify(run.result ?? [], null, 2)`；失败·取消=「复制日志」lines 按 seq 升序 `join('\n')`，空则回退 `error.summary + '\n' + error.detail`。
- **提交门铁律**：每 task `npx tsc --noEmit && npm test && npm run build` 全链 `&&` 通过才 commit（84bc161 事故教训：只卡 npm test 会漏 tsc）。
- **仓内文件以当前为准**：先读再改，最小 diff；不整体替换含他人逻辑的文件。
- localStorage 键/preferences 相关不在本块范围，勿触碰。

---

### Task 1: 纯函数层——copyPayload + clipboard + CopyButton

**Files:**
- Create: `src/data/copyPayload.ts`；Test: `src/data/copyPayload.test.ts`
- Create: `src/lib/clipboard.ts`；Test: `src/lib/clipboard.test.ts`
- Create: `src/components/CopyButton.tsx`；Test: `src/components/CopyButton.test.tsx`

**Interfaces:**
- Consumes: 无（叶子层；`CopyableRun` 为结构化子集类型，**不 import store**，与 `CommandRun` 结构兼容）。
- Produces: `copyPayloadFor(run: CopyableRun): CopyPayload | null`；`copyText(text: string): Promise<boolean>`；`<CopyButton label getText testid />`。

- [ ] **Step 1: 写失败测试**

`src/data/copyPayload.test.ts`：
```ts
import { copyPayloadFor, type CopyableRun } from './copyPayload'

const base: CopyableRun = { state: 'succeeded', lines: [], result: undefined, error: undefined }

test('succeeded → 复制结构化结果(result JSON,缩进2;缺省=[])', () => {
  expect(copyPayloadFor({ ...base, result: [{ a: 1 }] }))
    .toEqual({ label: '复制结构化结果', text: JSON.stringify([{ a: 1 }], null, 2) })
  expect(copyPayloadFor(base)!.text).toBe('[]')
})

test('failed → 复制日志(lines 按 seq 升序 join)', () => {
  const run: CopyableRun = { ...base, state: 'failed', lines: [
    { seq: 2, text: 'world' }, { seq: 1, text: 'hello' },
  ] }
  expect(copyPayloadFor(run)).toEqual({ label: '复制日志', text: 'hello\nworld' })
})

test('failed 且 lines=[] → 回退 error.summary+detail(启动失败可复制)', () => {
  const run: CopyableRun = { ...base, state: 'failed', error: { summary: 'boom', detail: 'stack' } }
  expect(copyPayloadFor(run)!.text).toBe('boom\nstack')
  expect(copyPayloadFor({ ...base, state: 'failed', error: { summary: 'boom' } })!.text).toBe('boom')
})

test('cancelled → 复制日志', () => {
  expect(copyPayloadFor({ ...base, state: 'cancelled', lines: [{ seq: 1, text: 'x' }] })!.label).toBe('复制日志')
})

test('非终态 → null', () => {
  for (const state of ['idle', 'starting', 'running', 'cancelling']) {
    expect(copyPayloadFor({ ...base, state })).toBeNull()
  }
})
```

`src/lib/clipboard.test.ts`：
```ts
import { copyText } from './clipboard'

test('navigator.clipboard.writeText 成功 → true', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  expect(await copyText('hi')).toBe(true)
  expect(writeText).toHaveBeenCalledWith('hi')
})

test('writeText 缺失 → 走 execCommand fallback', async () => {
  vi.stubGlobal('navigator', {})
  const exec = vi.fn().mockReturnValue(true)
  ;(document as Document & { execCommand?: typeof exec }).execCommand = exec
  expect(await copyText('hi')).toBe(true)
  expect(exec).toHaveBeenCalledWith('copy')
})

test('writeText reject → 走 fallback', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
  const exec = vi.fn().mockReturnValue(true)
  ;(document as Document & { execCommand?: typeof exec }).execCommand = exec
  expect(await copyText('hi')).toBe(true)
})

test('两路全败 → false', async () => {
  vi.stubGlobal('navigator', {})
  ;(document as Document & { execCommand?: () => boolean }).execCommand = () => { throw new Error('nope') }
  expect(await copyText('hi')).toBe(false)
})
```
（注：jsdom 的 `document.execCommand` 不存在，测试显式赋值即可；`vi.unstubAllGlobals` 由 vitest.setup afterEach 兜底。）

`src/components/CopyButton.test.tsx`：
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CopyButton } from './CopyButton'

test('点击复制成功 → 文案短暂变「已复制」', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  render(<CopyButton label="复制命令" getText={() => 'opencli x y'} testid="copy-x" />)
  await userEvent.click(screen.getByTestId('copy-x'))
  expect(writeText).toHaveBeenCalledWith('opencli x y')
  await waitFor(() => expect(screen.getByTestId('copy-x')).toHaveTextContent('已复制'))
})

test('复制失败 → 文案「复制失败」', async () => {
  vi.stubGlobal('navigator', {})
  ;(document as Document & { execCommand?: () => boolean }).execCommand = () => false
  render(<CopyButton label="复制命令" getText={() => 'x'} testid="copy-x" />)
  await userEvent.click(screen.getByTestId('copy-x'))
  await waitFor(() => expect(screen.getByTestId('copy-x')).toHaveTextContent('复制失败'))
})

test('1.5s 后文案回弹', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  render(<CopyButton label="复制命令" getText={() => 'x'} testid="copy-x" />)
  await userEvent.click(screen.getByTestId('copy-x'))
  await waitFor(() => expect(screen.getByTestId('copy-x')).toHaveTextContent('已复制'))
  await waitFor(() => expect(screen.getByTestId('copy-x')).toHaveTextContent('复制命令'), { timeout: 2500 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "C:/Users/Lauseusing/Developer/opencli-app-clone" && npx vitest run src/data/copyPayload.test.ts src/lib/clipboard.test.ts src/components/CopyButton.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

`src/data/copyPayload.ts`：
```ts
// 结构化子集:与 store 的 CommandRun 结构兼容,但不 import store(保持 data 层叶子纯净)
export type CopyableRun = {
  state: string
  lines: { seq: number; text: string }[]
  result?: Record<string, unknown>[]
  error?: { summary: string; detail?: string }
}

export type CopyPayload = { label: string; text: string }

export function copyPayloadFor(run: CopyableRun): CopyPayload | null {
  if (run.state === 'succeeded') {
    return { label: '复制结构化结果', text: JSON.stringify(run.result ?? [], null, 2) }
  }
  if (run.state === 'failed' || run.state === 'cancelled') {
    const log = [...run.lines].sort((a, b) => a.seq - b.seq).map((l) => l.text).join('\n')
    const fallback = run.error ? [run.error.summary, run.error.detail].filter(Boolean).join('\n') : ''
    return { label: '复制日志', text: log || fallback }   // 启动失败 lines=[] 回退 error
  }
  return null
}
```

`src/lib/clipboard.ts`：
```ts
// 降级次序:navigator.clipboard.writeText 缺失或 reject 后才走 textarea+execCommand;两路皆败返 false
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* writeText reject → 落 fallback */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
```

`src/components/CopyButton.tsx`：
```tsx
import { useEffect, useRef, useState } from 'react'
import { copyText } from '../lib/clipboard'

export function CopyButton({ label, getText, testid }: { label: string; getText: () => string; testid: string }) {
  const [flash, setFlash] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const onClick = async () => {
    const ok = await copyText(getText())
    setFlash(ok ? 'ok' : 'fail')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setFlash('idle'), 1500)
  }
  return (
    <button data-testid={testid} onClick={onClick}
      className="rounded-lg px-2 py-1 text-xs"
      style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}>
      {flash === 'ok' ? '已复制' : flash === 'fail' ? '复制失败' : label}
    </button>
  )
}
```

- [ ] **Step 4: 跑测试确认通过 + 三门**

Run: 同 Step 2 → 全绿；再 `npx tsc --noEmit && npm test && npm run build`。

- [ ] **Step 5: 提交**

```bash
git add src/data/copyPayload.ts src/data/copyPayload.test.ts src/lib/clipboard.ts src/lib/clipboard.test.ts src/components/CopyButton.tsx src/components/CopyButton.test.tsx
git commit -m "feat(copy): 语境化复制纯函数层——copyPayload 三态口径 + clipboard 降级链 + CopyButton 反馈回弹"
```

---

### Task 2: server 基础——buildExecutionPolicy 抽取 + resolveManifestPath

**Files:**
- Modify: `server/policy.mjs`（抽纯函数，`loadExecutionPolicy` 变薄包装）
- Modify: `server/opencli-entry.mjs`（新增 `resolveManifestPath`）
- Test: `server/policy.test.mjs`、`server/opencli-entry.test.mjs`（末尾追加，保留现有）

**Interfaces:**
- Consumes: 现有 `loadExecutionPolicy(catalogPath)` 行为（不得改变）。
- Produces: `buildExecutionPolicy(snapshot) → { opencliVersion, allowedCommands: Set, description }`；`resolveManifestPath(entry, { existsImpl? }) → string`（从 `…/dist/src/main.js` 反推包根 `cli-manifest.json`，不存在则 throw）。

- [ ] **Step 1: 追加失败测试**

`server/policy.test.mjs` 末尾：
```js
import { buildExecutionPolicy } from './policy.mjs'

it('buildExecutionPolicy: 纯函数过滤 read+public+browser=false', () => {
  const policy = buildExecutionPolicy({
    opencliVersion: '9.9.9',
    commands: [
      { command: 'a/ok', access: 'read', strategy: 'public', browser: false },
      { command: 'a/write', access: 'write', strategy: 'public', browser: false },
      { command: 'a/priv', access: 'read', strategy: 'private', browser: false },
      { command: 'a/br', access: 'read', strategy: 'public', browser: true },
    ],
  })
  expect([...policy.allowedCommands]).toEqual(['a/ok'])
  expect(policy.opencliVersion).toBe('9.9.9')
})

it('buildExecutionPolicy: commands 非数组 → throw', () => {
  expect(() => buildExecutionPolicy({})).toThrow()
})
```

`server/opencli-entry.test.mjs` 末尾：
```js
import { resolveManifestPath } from './opencli-entry.mjs'

it('resolveManifestPath: 从 entry 反推包根 cli-manifest.json', () => {
  const entry = 'C:\\x\\node_modules\\@jackwener\\opencli\\dist\\src\\main.js'
  const seen = []
  const path = resolveManifestPath(entry, { existsImpl: (p) => { seen.push(p); return true } })
  expect(path.replace(/\\/g, '/')).toMatch(/@jackwener\/opencli\/cli-manifest\.json$/)
  expect(seen).toHaveLength(1)
})

it('resolveManifestPath: manifest 不存在 → throw', () => {
  expect(() => resolveManifestPath('C:\\x\\dist\\src\\main.js', { existsImpl: () => false }))
    .toThrow(/cli-manifest/)
})
```

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run server/policy.test.mjs server/opencli-entry.test.mjs` → FAIL（未导出）。

- [ ] **Step 3: 实现**

`server/policy.mjs`：把 `loadExecutionPolicy` 拆为（保留 `RequestPolicyError`、`validateStartRequest`、`validateCancelRequest` 等其余内容一字不动）：
```js
export function buildExecutionPolicy(snapshot) {
  if (!Array.isArray(snapshot.commands)) {
    throw new Error('Catalog snapshot has no commands array')
  }
  const allowedCommands = new Set(
    snapshot.commands
      .filter((command) => (
        command.access === 'read'
        && command.strategy === 'public'
        && command.browser === false
      ))
      .map((command) => command.command),
  )
  return {
    opencliVersion: snapshot.opencliVersion,
    allowedCommands,
    description: 'catalog: access=read, strategy=public, browser=false',
  }
}

export function loadExecutionPolicy(catalogPath) {
  const snapshot = JSON.parse(readFileSync(catalogPath, 'utf8').replace(/^﻿/, ''))
  return buildExecutionPolicy(snapshot)
}
```

`server/opencli-entry.mjs` 末尾追加：
```js
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// entry = …/@jackwener/opencli/dist/src/main.js → 包根 = entry/../../.. → cli-manifest.json
// 不硬编码全局 npm 路径:包在哪,manifest 就在哪
export function resolveManifestPath(entry, { existsImpl = existsSync } = {}) {
  const packageRoot = resolve(dirname(entry), '..', '..')
  const manifestPath = join(packageRoot, 'cli-manifest.json')
  if (!existsImpl(manifestPath)) {
    throw new Error(`cli-manifest.json not found at ${manifestPath} (derived from ${entry})`)
  }
  return manifestPath
}
```
（`import` 语句合并到文件顶部现有 import 区；`node:path`/`node:fs` 若已 import 则复用。）

- [ ] **Step 4: 跑确认通过 + 三门**

Run: Step 2 命令全绿 → `npx tsc --noEmit && npm test && npm run build`。

- [ ] **Step 5: 提交**

```bash
git add server/policy.mjs server/policy.test.mjs server/opencli-entry.mjs server/opencli-entry.test.mjs
git commit -m "feat(server): buildExecutionPolicy 纯函数抽取 + resolveManifestPath 包根反推(CatalogService 地基)"
```

---

### Task 3: server CatalogService（原子刷新 + 资源边界）

**Files:**
- Create: `server/catalog-service.mjs`；Test: `server/catalog-service.test.mjs`

**Interfaces:**
- Consumes: `buildExecutionPolicy`（Task 2）、`resolveManifestPath` 产物路径、`stripBom/mergeManifestFields`（`../src/data/normalize.ts`，Node≥23 type-stripping，`sync-catalog.mjs` 已实证）。
- Produces: `createCatalogService({ opencliEntry, manifestPath, spawnImpl?, readFileImpl?, now?, timeoutMs?, maxOutputBytes? }) → { refresh(): Promise<snapshot>, current(): {snapshot, policy}|undefined, close() }`；`CatalogServiceError`（带 `statusCode`）。

- [ ] **Step 1: 写失败测试** `server/catalog-service.test.mjs`：

```js
// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createCatalogService, CatalogServiceError } from './catalog-service.mjs'

const LIST = JSON.stringify([
  { command: 'a/ok', site: 'a', name: 'ok', description: '', access: 'read', strategy: 'public', browser: false, args: [] },
])
const MANIFEST = JSON.stringify([{ site: 'a', name: 'ok', type: 'json' }])

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kills = []
  child.kill = (sig) => { child.kills.push(sig); return true }
  return child
}

function setup(overrides = {}) {
  const children = []
  const spawnCalls = []
  const service = createCatalogService({
    opencliEntry: 'C:/fixture/dist/src/main.js',
    manifestPath: 'C:/fixture/cli-manifest.json',
    spawnImpl: (cmd, argv, opts) => {
      spawnCalls.push({ cmd, argv, opts })
      const child = fakeChild()
      children.push(child)
      return child
    },
    readFileImpl: (path) => (String(path).includes('package.json') ? '{"version":"9.9.9"}' : MANIFEST),
    timeoutMs: 30,
    ...overrides,
  })
  return { service, children, spawnCalls }
}

function emitSuccess(child, payload = LIST) {
  child.stdout.emit('data', Buffer.from(payload))
  child.emit('close', 0)
}

describe('CatalogService', () => {
  it('成功刷新:spawn 姿势正确 + snapshot/policy 原子生效', async () => {
    const { service, children, spawnCalls } = setup()
    const refreshing = service.refresh()
    emitSuccess(children[0])
    const snapshot = await refreshing
    expect(spawnCalls[0].cmd).toBe(process.execPath)
    expect(spawnCalls[0].argv).toEqual(['C:/fixture/dist/src/main.js', 'list', '-f', 'json'])
    expect(spawnCalls[0].opts).toMatchObject({ shell: false })
    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.commands[0].type).toBe('json')            // manifest 字段已 merge
    expect(snapshot.opencliVersion).toBe('9.9.9')
    expect(service.current().policy.allowedCommands.has('a/ok')).toBe(true)
  })

  it('single-flight:并发 refresh 只 spawn 一次', async () => {
    const { service, children, spawnCalls } = setup()
    const p1 = service.refresh(); const p2 = service.refresh()
    emitSuccess(children[0])
    await Promise.all([p1, p2])
    expect(spawnCalls).toHaveLength(1)
  })

  it('非零退出 → 502 且旧值不动', async () => {
    const { service, children } = setup()
    const p1 = service.refresh(); emitSuccess(children[0]); await p1
    const before = service.current()
    const p2 = service.refresh()
    children[1].stderr.emit('data', Buffer.from('boom'))
    children[1].emit('close', 3)
    await expect(p2).rejects.toMatchObject({ statusCode: 502 })
    expect(service.current()).toBe(before)                    // 原子:失败旧值不动
  })

  it('超时 → 504 + kill', async () => {
    const { service, children } = setup({ timeoutMs: 15 })
    const p = service.refresh()
    await expect(p).rejects.toMatchObject({ statusCode: 504 })
    expect(children[0].kills.length).toBeGreaterThan(0)
  })

  it('stdout 超限 → 502 + kill', async () => {
    const { service, children } = setup({ maxOutputBytes: 8 })
    const p = service.refresh()
    children[0].stdout.emit('data', Buffer.from('123456789'))
    await expect(p).rejects.toMatchObject({ statusCode: 502 })
    expect(children[0].kills.length).toBeGreaterThan(0)
  })

  it('坏 JSON → 500', async () => {
    const { service, children } = setup()
    const p = service.refresh()
    emitSuccess(children[0], '{not json')
    await expect(p).rejects.toMatchObject({ statusCode: 500 })
  })

  it('manifest 读取失败 → 500', async () => {
    const { service, children } = setup({ readFileImpl: () => { throw new Error('ENOENT') } })
    const p = service.refresh()
    emitSuccess(children[0])
    await expect(p).rejects.toMatchObject({ statusCode: 500 })
  })

  it('schema 校验失败(命令缺字段) → 500', async () => {
    const { service, children } = setup()
    const p = service.refresh()
    emitSuccess(children[0], JSON.stringify([{ command: 'a/bad' }]))
    await expect(p).rejects.toMatchObject({ statusCode: 500 })
  })

  it('close() kill 在途子进程,之后 refresh 拒绝', async () => {
    const { service, children } = setup()
    const p = service.refresh()
    service.close()
    expect(children[0].kills.length).toBeGreaterThan(0)
    await expect(p).rejects.toBeInstanceOf(CatalogServiceError)
    await expect(service.refresh()).rejects.toMatchObject({ statusCode: 500 })
  })
})
```

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run server/catalog-service.test.mjs` → FAIL（模块不存在）。

- [ ] **Step 3: 实现** `server/catalog-service.mjs`：

```js
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { stripBom, mergeManifestFields } from '../src/data/normalize.ts'
import { buildExecutionPolicy } from './policy.mjs'

export class CatalogServiceError extends Error {
  constructor(statusCode, message, detail) {
    super(message)
    this.name = 'CatalogServiceError'
    this.statusCode = statusCode
    this.detail = detail
  }
}

// 现场重生成 catalog:spawn opencli list(P0-B 同款安全姿势)→ manifest merge → schema 校验
// → buildExecutionPolicy → 全部成功后单引用原子替换 {snapshot, policy};任一失败旧值不动。
export function createCatalogService({
  opencliEntry,
  manifestPath,
  spawnImpl = spawn,
  readFileImpl = readFileSync,
  now = Date.now,
  timeoutMs = 15_000,
  maxOutputBytes = 8 * 1024 * 1024,
}) {
  let state              // { snapshot, policy } | undefined —— 单引用,原子换
  let inflight           // Promise | undefined —— single-flight
  let activeChild        // 在途子进程,close() 时 kill
  let closed = false

  const runList = () => new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl(process.execPath, [opencliEntry, 'list', '-f', 'json'], {
      shell: false,
      windowsHide: true,
    })
    activeChild = child
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      if (activeChild === child) activeChild = undefined
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      child.kill('SIGKILL')
      rejectPromise(error)
    }
    const timer = setTimeout(
      () => fail(new CatalogServiceError(504, `opencli list timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    timer.unref?.()
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxOutputBytes) {
        fail(new CatalogServiceError(502, `opencli list output exceeded ${maxOutputBytes} bytes`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => { if (stderr.length < 64) stderr.push(chunk) })
    child.once('error', (error) => fail(new CatalogServiceError(502, 'Failed to spawn opencli list', error.message)))
    child.once('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (code !== 0) {
        rejectPromise(new CatalogServiceError(
          502,
          `opencli list exited with code ${code}`,
          Buffer.concat(stderr).toString('utf8').slice(0, 2048),
        ))
        return
      }
      resolvePromise(Buffer.concat(stdout).toString('utf8'))
    })
  })

  const readOpencliVersion = () => {
    try {
      const raw = readFileImpl(join(dirname(manifestPath), 'package.json'), 'utf8')
      const version = JSON.parse(stripBom(String(raw))).version
      return typeof version === 'string' ? version : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  const doRefresh = async () => {
    if (closed) throw new CatalogServiceError(500, 'Catalog service is closed')
    const listRaw = await runList()
    if (closed) throw new CatalogServiceError(500, 'Catalog service is closed')
    let list
    try {
      list = JSON.parse(stripBom(listRaw))
    } catch {
      throw new CatalogServiceError(500, 'opencli list output is not valid JSON')
    }
    if (!Array.isArray(list)) throw new CatalogServiceError(500, 'opencli list output is not an array')
    let manifestRaw
    let manifest
    try {
      manifestRaw = String(readFileImpl(manifestPath, 'utf8'))
      manifest = JSON.parse(stripBom(manifestRaw))
    } catch (error) {
      throw new CatalogServiceError(500, 'Failed to read cli-manifest.json', error instanceof Error ? error.message : String(error))
    }
    const commands = mergeManifestFields(list, manifest)
    assertCommands(commands)
    const snapshot = {
      schemaVersion: 1,
      generatedAt: now(),
      opencliVersion: readOpencliVersion(),
      source: 'live: opencli list -f json',
      listSha256: createHash('sha256').update(listRaw).digest('hex'),
      manifestSha256: createHash('sha256').update(manifestRaw).digest('hex'),
      commands,
    }
    const policy = buildExecutionPolicy(snapshot)
    state = { snapshot, policy }        // ← 全部成功后才替换,单引用原子
    return snapshot
  }

  return {
    refresh() {
      if (!inflight) {
        inflight = doRefresh().finally(() => { inflight = undefined })
      }
      return inflight
    },
    current() { return state },
    close() {
      closed = true
      activeChild?.kill('SIGKILL')
      activeChild = undefined
    },
  }
}

function assertCommands(commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new CatalogServiceError(500, 'Catalog has no commands')
  }
  for (const c of commands) {
    if (!c || typeof c.command !== 'string' || typeof c.site !== 'string' || typeof c.name !== 'string'
      || !('access' in c) || !Array.isArray(c.args)) {
      throw new CatalogServiceError(500, `Catalog command is malformed: ${c && c.command ? c.command : '?'}`)
    }
  }
}
```
（注意 close 测试路径：`close()` 先置 `closed=true` 并 kill 在途 child——被 kill 的 fakeChild 不会自动 emit close，`runList` 的 promise 会因 timeout 而 fail；为让「close 后在途 refresh 拒绝」确定性成立，`fail` 时 `closed` 已 true。实现者若发现 fakeChild kill 后 promise 悬挂导致该测试超时，正确修法是在 `close()` 里对在途 promise 主动 fail——在 `runList` 作用域外持一个 `failActive` 引用：`close()` 调 `failActive?.(new CatalogServiceError(500, 'Catalog service is closed'))`。把 `fail` 暴露为 `failActive = fail`（spawn 时赋值，cleanup 时清空）。这是预期实现，按此写。）

- [ ] **Step 4: 跑确认通过 + 三门**

Run: `npx vitest run server/catalog-service.test.mjs` 全绿 → `npx tsc --noEmit && npm test && npm run build`。

- [ ] **Step 5: 提交**

```bash
git add server/catalog-service.mjs server/catalog-service.test.mjs
git commit -m "feat(server): CatalogService——现场重生成+policy 校验后原子替换;15s 超时/8MiB 上限/single-flight/close 杀在途"
```

---

### Task 4: server 接线——GET /catalog + 动态 policy + index.mjs

**Files:**
- Modify: `server/host-server.mjs`（`catalogService` 参数 + `activePolicy()` + `GET /catalog` 路由 + close 链）
- Modify: `server/index.mjs`（创建 service 并注入）
- Test: `server/host-server.test.mjs`（末尾追加,复用现有 `setup()` 基建——先读该文件）

**Interfaces:**
- Consumes: Task 3 的 `{ refresh, current, close }` 接口与 `CatalogServiceError.statusCode`；Task 2 的 `resolveManifestPath`。
- Produces: `createHostServer({ …, catalogService? })`；`GET /catalog` 端点（200=刷新后 snapshot；错误码透传 CatalogServiceError.statusCode）；`/start`/`/health` 改读 `activePolicy()`。

- [ ] **Step 1: 追加失败测试**（`server/host-server.test.mjs` 末尾；`setup()` 需先扩展为接受 `catalogService` 透传给 `createHostServer`——最小 diff：`async function setup(extra = {})` 且 `createHostServer({ …现有, ...extra })`）：

```js
describe('GET /catalog + 动态 policy', () => {
  function stubCatalogService() {
    const snapshot = {
      schemaVersion: 1, generatedAt: 123, opencliVersion: '9.9.9',
      source: 'live: opencli list -f json', listSha256: 'x', manifestSha256: 'y',
      commands: [
        { command: 'newsite/hello', site: 'newsite', name: 'hello', description: '', access: 'read', strategy: 'public', browser: false, args: [] },
      ],
    }
    const policy = {
      opencliVersion: '9.9.9',
      description: 'refreshed',
      allowedCommands: new Set(['newsite/hello']),
    }
    let state
    return {
      snapshot,
      refresh: async () => { state = { snapshot, policy }; return snapshot },
      current: () => state,
      close: () => {},
    }
  }

  it('刷新前旧 policy 拒绝新命令;刷新后放行、旧命令 403(漂移闭环)', async () => {
    const service = stubCatalogService()
    const { baseUrl } = await setup({ catalogService: service })
    const startNew = () => post(baseUrl, '/start', {
      runId: 'r-new-1', commandKey: 'newsite/hello', argv: ['newsite', 'hello', '-f', 'json'],
    })
    const startOld = () => post(baseUrl, '/start', {
      runId: 'r-old-1', commandKey: '36kr/news', argv: ['36kr', 'news', '-f', 'json'],
    })
    expect((await startNew()).status).toBe(403)               // 刷新前:初始 policy 无 newsite/hello
    const refreshed = await fetch(`${baseUrl}/catalog`, { headers: { Origin: origin } })
    expect(refreshed.status).toBe(200)
    expect((await refreshed.json()).commands[0].command).toBe('newsite/hello')
    expect((await startNew()).status).toBe(202)               // 刷新后:动态 policy 放行
    expect((await startOld()).status).toBe(403)               // 已删命令被拒
  })

  it('刷新失败 → 透传 CatalogServiceError.statusCode,不改 policy', async () => {
    const service = {
      refresh: async () => { const e = new Error('timed out'); e.statusCode = 504; e.name = 'CatalogServiceError'; throw e },
      current: () => undefined,
      close: () => {},
    }
    const { baseUrl } = await setup({ catalogService: service })
    const res = await fetch(`${baseUrl}/catalog`, { headers: { Origin: origin } })
    expect(res.status).toBe(504)
    const body = await res.json()
    expect(body.error.summary).toMatch(/timed out/)
    // 原 policy 未被破坏:白名单内命令仍可 start
    expect((await post(baseUrl, '/start', { runId: 'r-ok-1', commandKey: '36kr/news', argv: ['36kr', 'news', '-f', 'json'] })).status).toBe(202)
  })

  it('未配置 catalogService → GET /catalog 404', async () => {
    const { baseUrl } = await setup()
    const res = await fetch(`${baseUrl}/catalog`, { headers: { Origin: origin } })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run server/host-server.test.mjs` → 新 3 条 FAIL,现有全绿。

- [ ] **Step 3: 实现**

`server/host-server.mjs` 最小 diff：
1. 签名加 `catalogService`：`export function createHostServer({ opencliEntry, policy, catalogService, allowedOrigins = […], maxBodyBytes = 64 * 1024, runManagerOptions = {} } = {})`。
2. `if (!policy) throw …` 之后加：
```js
  const activePolicy = () => catalogService?.current()?.policy ?? policy
```
3. `/health` 内 `policy.opencliVersion`/`policy.description` 改为 `activePolicy().opencliVersion`/`activePolicy().description`。
4. `/start` 内 `validateStartRequest(body, policy)` 改为 `validateStartRequest(body, activePolicy())`。
5. 在 `/events` 路由块**之前**（已过强制 CORS 门之后）插入：
```js
      if (url.pathname === '/catalog' && request.method === 'GET') {
        if (!catalogService) {
          writeJson(response, 404, { error: 'Catalog refresh is not enabled' })
          return
        }
        try {
          const snapshot = await catalogService.refresh()
          writeJson(response, 200, snapshot)      // 只在原子替换完成后返回:目录与生效 policy 恒一致
        } catch (error) {
          const statusCode = (error && typeof error === 'object' && Number.isInteger(error.statusCode))
            ? error.statusCode
            : 500
          writeJson(response, statusCode, {
            error: {
              summary: error instanceof Error ? error.message : 'Catalog refresh failed',
              ...(error && typeof error === 'object' && error.detail ? { detail: error.detail } : {}),
            },
          })
        }
        return
      }
```
6. `close()` 里 `runManager.close()` 之前加 `catalogService?.close()`。

`server/index.mjs`：
```js
import { resolveOpenCliEntry, resolveManifestPath } from './opencli-entry.mjs'
import { createCatalogService } from './catalog-service.mjs'
```
`const opencliEntry = resolveOpenCliEntry()` 之后：
```js
const catalogService = createCatalogService({
  opencliEntry,
  manifestPath: resolveManifestPath(opencliEntry),
})
```
`createHostServer({...})` 参数加 `catalogService,`。

- [ ] **Step 4: 跑确认通过 + 三门**

Run: `npx vitest run server/host-server.test.mjs` 全绿 → `npx tsc --noEmit && npm test && npm run build`。

- [ ] **Step 5: 提交**

```bash
git add server/host-server.mjs server/host-server.test.mjs server/index.mjs
git commit -m "feat(server): GET /catalog 接线+/start 改读动态 policy(activePolicy)——刷新即生效,漂移闭环回归测试坐实"
```

---

### Task 5: 前端 CatalogSource 抽象

**Files:**
- Modify: `src/data/catalog.ts`（`loadCatalog` 加 `opts`；`export` assertSnapshot）
- Create: `src/host/catalogSource.ts`；Test: `src/host/catalogSource.test.ts`
- Modify: `src/host/index.ts`（`HostSelection` 加 `catalogSource`）+ `src/host/nodeBridgeHost.ts`（`DEFAULT_BASE_URL` 加 export）
- Test: `src/host/index.test.ts`（若存在则追加;不存在则新建仅覆盖 selection 的用例）

**Interfaces:**
- Consumes: `assertSnapshot`/`CatalogError`（catalog.ts）、`DEFAULT_BASE_URL`（nodeBridgeHost）。
- Produces: `type CatalogLoadResult = { snapshot: CatalogSnapshot; degraded?: string }`；`type CatalogSource = { kind: 'snapshot' | 'live'; load(): Promise<CatalogLoadResult> }`；`snapshotCatalogSource(fetchImpl?)`；`liveCatalogSource(baseUrl, fetchImpl?)`；`createHostSelection` 返回 `{ host, catalogSource, mode }`。

- [ ] **Step 1: 写失败测试** `src/host/catalogSource.test.ts`：

```ts
import { snapshotCatalogSource, liveCatalogSource } from './catalogSource'
import { createHostSelection } from './index'

const SNAP = {
  schemaVersion: 1, generatedAt: 1, opencliVersion: 'x', source: 's', listSha256: 'a', manifestSha256: 'b',
  commands: [{ command: 'a/b', site: 'a', name: 'b', description: '', access: 'read', browser: false, args: [] }],
}
const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as Response

test('snapshot source: no-store 拉快照,无 degraded', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(okJson(SNAP))
  const { snapshot, degraded } = await snapshotCatalogSource(fetchImpl as unknown as typeof fetch).load()
  expect(fetchImpl).toHaveBeenCalledWith('/catalog.snapshot.json', expect.objectContaining({ cache: 'no-store' }))
  expect(snapshot.commands).toHaveLength(1)
  expect(degraded).toBeUndefined()
})

test('live source: GET {base}/catalog 成功,无 degraded', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(okJson(SNAP))
  const { snapshot, degraded } = await liveCatalogSource('http://127.0.0.1:9999', fetchImpl as unknown as typeof fetch).load()
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9999/catalog')
  expect(snapshot.schemaVersion).toBe(1)
  expect(degraded).toBeUndefined()
})

test('live 失败 → 降级 snapshot 并带 degraded 原因', async () => {
  const fetchImpl = vi.fn()
    .mockRejectedValueOnce(new Error('ECONNREFUSED'))         // live
    .mockResolvedValueOnce(okJson(SNAP))                      // fallback snapshot
  const { snapshot, degraded } = await liveCatalogSource('http://127.0.0.1:9999', fetchImpl as unknown as typeof fetch).load()
  expect(snapshot.commands).toHaveLength(1)
  expect(degraded).toMatch(/ECONNREFUSED/)
})

test('live 与 snapshot 双败 → 抛错', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('all down'))
  await expect(liveCatalogSource('http://x', fetchImpl as unknown as typeof fetch).load()).rejects.toThrow()
})

test('createHostSelection: demo→snapshot 源;node→live 源', () => {
  expect(createHostSelection({}).catalogSource.kind).toBe('snapshot')
  expect(createHostSelection({ search: '?host=node' }).catalogSource.kind).toBe('live')
})
```

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run src/host/catalogSource.test.ts` → FAIL。

- [ ] **Step 3: 实现**

`src/data/catalog.ts`：
- `assertSnapshot` 前加 `export`。
- `loadCatalog` 改为：
```ts
export async function loadCatalog(opts: { cache?: RequestCache; fetchImpl?: typeof fetch } = {}): Promise<CatalogSnapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const res = await fetchImpl('/catalog.snapshot.json', opts.cache ? { cache: opts.cache } : undefined)
  if (!res.ok) throw new CatalogError(`加载 catalog 失败：${res.status}`)
  return assertSnapshot(await res.json())
}
```
（现有无参调用 `loadCatalog()` 兼容不变。）

`src/host/nodeBridgeHost.ts`：`const DEFAULT_BASE_URL` → `export const DEFAULT_BASE_URL`。

`src/host/catalogSource.ts`：
```ts
import { loadCatalog, assertSnapshot, CatalogError } from '../data/catalog'
import type { CatalogSnapshot } from '../data/types'

export type CatalogLoadResult = { snapshot: CatalogSnapshot; degraded?: string }
export type CatalogSource = {
  kind: 'snapshot' | 'live'
  load(): Promise<CatalogLoadResult>
}

export function snapshotCatalogSource(fetchImpl: typeof fetch = fetch): CatalogSource {
  return {
    kind: 'snapshot',
    async load() {
      return { snapshot: await loadCatalog({ cache: 'no-store', fetchImpl }) }
    },
  }
}

// live 失败自动降级 snapshot(决策⑥),degraded 带原因供 UI 区分「真刷新成功」与「降级」
export function liveCatalogSource(baseUrl: string, fetchImpl: typeof fetch = fetch): CatalogSource {
  const base = baseUrl.replace(/\/$/, '')
  return {
    kind: 'live',
    async load() {
      try {
        const res = await fetchImpl(`${base}/catalog`)
        if (!res.ok) throw new CatalogError(`刷新目录失败：HTTP ${res.status}`)
        return { snapshot: assertSnapshot(await res.json()) }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const snapshot = await loadCatalog({ cache: 'no-store', fetchImpl })   // 双败则整体抛出
        return { snapshot, degraded: `Host 目录不可达，已降级本地快照：${reason}` }
      }
    },
  }
}
```

`src/host/index.ts`：
```ts
import { createMockHost } from './mockHost'
import { createNodeBridgeHost, DEFAULT_BASE_URL } from './nodeBridgeHost'
import { liveCatalogSource, snapshotCatalogSource, type CatalogSource } from './catalogSource'
import type { HostBridge } from './types'

export * from './types'
export * from './mockHost'
export * from './nodeBridgeHost'
export * from './catalogSource'

export type HostEnvironment = Record<string, string | undefined>
export type HostSelection = {
  host: HostBridge
  catalogSource: CatalogSource
  mode: 'demo' | 'connected'
}

export function createHostSelection({ search = '', env = {} }: { search?: string; env?: HostEnvironment } = {}): HostSelection {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const selected = query.get('host') ?? env.VITE_HOST_MODE ?? 'mock'
  if (selected.toLowerCase() === 'node') {
    const baseUrl = env.VITE_NODE_HOST_URL ?? DEFAULT_BASE_URL
    return {
      host: createNodeBridgeHost({ baseUrl }),
      catalogSource: liveCatalogSource(baseUrl),
      mode: 'connected',
    }
  }
  return { host: createMockHost(), catalogSource: snapshotCatalogSource(), mode: 'demo' }
}
```

- [ ] **Step 4: 跑确认通过 + 三门**

Run: `npx vitest run src/host/catalogSource.test.ts` 全绿；若 `src/host` 已有其他测试一并跑 → `npx tsc --noEmit && npm test && npm run build`。

- [ ] **Step 5: 提交**

```bash
git add src/data/catalog.ts src/host/catalogSource.ts src/host/catalogSource.test.ts src/host/index.ts src/host/nodeBridgeHost.ts
git commit -m "feat(host): CatalogSource 抽象——demo/live 双源共享 baseUrl,live 失败降级 snapshot 带 degraded 标记"
```

---

### Task 6: store——setCommands 三分支 reconcileSelection

**Files:**
- Modify: `src/store/appStore.ts`；Test: `src/store/appStore.test.ts`（末尾 describe 追加）

**Interfaces:**
- Consumes: 现有 `defaultsOf`、`setCommands`。
- Produces: `setCommands` 扩展语义（A 同 key 换新+活值合并 / B key 删清空 / C `currentRun` 不动）；内部纯 helper `reconcileSelection`（不导出）。

- [ ] **Step 1: 追加失败测试**（`appStore.test.ts` 末尾新 describe；`cmd`/`initialState` 顶部已有）：

```ts
describe('setCommands selection reconcile(块 B 阻塞3)', () => {
  beforeEach(() => { useAppStore.setState(initialState, true); localStorage.clear() })
  const mk = (over: Partial<CommandManifest> = {}): CommandManifest => ({
    command: 'x/login', site: 'x', name: 'login', description: '', access: 'read', browser: false,
    args: [
      { name: 'user', type: 'str', required: true },
      { name: 'limit', type: 'int', default: 10 },
    ],
    ...over,
  })

  test('A: 同 key 仍在 → selected 换新 manifest,活值保留+新参补默认+消失参数丢弃', () => {
    useAppStore.getState().selectCommand(mk())
    useAppStore.getState().setValue('user', 'alice')          // 活值
    const next = mk({ description: 'v2', args: [
      { name: 'user', type: 'str', required: true },          // 保留
      { name: 'page', type: 'int', default: 1 },              // 新参数
      // limit 已删除
    ] })
    useAppStore.getState().setCommands([next])
    const s = useAppStore.getState()
    expect(s.selected?.description).toBe('v2')                // 新 manifest
    expect(s.values).toEqual({ user: 'alice', page: 1 })      // 活值+新默认;limit 丢弃
  })

  test('B: 同 key 已删 → 清空 selected/values', () => {
    useAppStore.getState().selectCommand(mk())
    useAppStore.getState().setCommands([mk({ command: 'y/other', site: 'y', name: 'other' })])
    expect(useAppStore.getState().selected).toBeUndefined()
    expect(useAppStore.getState().values).toEqual({})
  })

  test('C: currentRun 不随刷新改写(历史快照)', () => {
    useAppStore.getState().selectCommand(mk())
    useAppStore.getState().beginRun('r-keep')
    const before = useAppStore.getState().currentRun
    useAppStore.getState().setCommands([])                    // 命令全删
    expect(useAppStore.getState().currentRun).toBe(before)    // 引用不变
    expect(useAppStore.getState().selected).toBeUndefined()
  })
})
```
（`CommandManifest` 若未 import 则在文件顶部补 `import type { CommandManifest } from '../data/types'`。）

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run src/store/appStore.test.ts` → 新 3 条 FAIL（A 断言 description 旧值/values 含 limit）。

- [ ] **Step 3: 实现**（`appStore.ts` 最小 diff）

`defaultsOf` 之后加：
```ts
// 刷新后 selection 校正(块 B 阻塞3):A 同 key→新 manifest+活值∩新参数保留+新参补默认;
// B key 删→清空;currentRun 永不改写(历史运行快照)
function reconcileSelection(
  selected: CommandManifest | undefined,
  values: Record<string, unknown>,
  commands: CommandManifest[],
): { selected?: CommandManifest; values: Record<string, unknown> } {
  if (!selected) return { selected: undefined, values: {} }
  const next = commands.find((c) => c.command === selected.command)
  if (!next) return { selected: undefined, values: {} }
  const merged = defaultsOf(next)
  const argNames = new Set(next.args.map((a) => a.name))
  for (const [k, v] of Object.entries(values)) if (argNames.has(k)) merged[k] = v
  return { selected: next, values: merged }
}
```
`setCommands` 改为：
```ts
  setCommands: (commands) => set((s) => ({
    commands, catalogStatus: 'ready', catalogError: undefined,
    stale: staleKeys(s.preferences, commands),
    ...reconcileSelection(s.selected, s.values, commands),
  })),
```

- [ ] **Step 4: 跑确认通过 + 三门**

Run: `npx vitest run src/store/appStore.test.ts` 全绿（**现有全部 preferences/run 测试必须仍绿**）→ `npx tsc --noEmit && npm test && npm run build`。

- [ ] **Step 5: 提交**

```bash
git add src/store/appStore.ts src/store/appStore.test.ts
git commit -m "feat(store): setCommands selection reconcile——同 key 换新 manifest 活值合并/key 删清空/currentRun 不动"
```

---

### Task 7: App/AppShell——executeSelected + 刷新控件 + headerActions

**Files:**
- Modify: `src/App.tsx`（`catalogSource` prop + `executeSelected` + 刷新 state/控件）
- Modify: `src/components/AppShell.tsx`（`headerActions` 槽）
- Modify: `src/main.tsx`（传 `catalogSource`）
- Test: `src/App.test.tsx`（末尾追加）

**Interfaces:**
- Consumes: Task 5 `CatalogSource/CatalogLoadResult/snapshotCatalogSource`；Task 6 reconcile（自动生效）；`validate`（`./features/config/validation`）。
- Produces: `App({ host?, catalogSource?, mode? })`；`executeSelected(): boolean`（传给 `CommandConfig` 的 `onRun`；Task 8 复用为 `onRerun`）；`AppShell` 新 prop `headerActions?: ReactNode`；testid：`refresh-catalog`/`catalog-meta`/`refresh-error`/`refresh-degraded`。

- [ ] **Step 1: 追加失败测试**（`App.test.tsx` 末尾；现有测试文件顶部的 render 基建复用——先读该文件确认工厂与 stub 惯例）：

```tsx
import { snapshotCatalogSource, type CatalogSource } from './host'

const SNAP = (over: Partial<{ generatedAt: number; commands: CommandManifest[] }> = {}) => ({
  schemaVersion: 1 as const, generatedAt: over.generatedAt ?? 1000, opencliVersion: 'x', source: 's',
  listSha256: 'a', manifestSha256: 'b',
  commands: over.commands ?? [{ command: 'a/b', site: 'a', name: 'b', description: '', access: 'read' as const, browser: false, args: [] }],
})

function sourceOf(loads: Array<() => Promise<{ snapshot: ReturnType<typeof SNAP>; degraded?: string }>>): CatalogSource {
  let i = 0
  return { kind: 'live', load: () => loads[Math.min(i++, loads.length - 1)]() }
}

test('刷新成功 → 目录更新 + generatedAt 显示', async () => {
  const source = sourceOf([
    async () => ({ snapshot: SNAP() }),
    async () => ({ snapshot: SNAP({ generatedAt: 2000, commands: [{ command: 'c/d', site: 'c', name: 'd', description: '', access: 'read', browser: false, args: [] }] }) }),
  ])
  render(<App catalogSource={source} />)
  await screen.findByTestId('refresh-catalog')
  await userEvent.click(screen.getByTestId('refresh-catalog'))
  await waitFor(() => expect(useAppStore.getState().commands[0].command).toBe('c/d'))
  expect(screen.getByTestId('catalog-meta')).toBeInTheDocument()
})

test('刷新失败 → 目录保持 ready(不出错误屏),按钮旁提示', async () => {
  const source = sourceOf([
    async () => ({ snapshot: SNAP() }),
    async () => { throw new Error('all down') },
  ])
  render(<App catalogSource={source} />)
  await screen.findByTestId('refresh-catalog')
  await userEvent.click(screen.getByTestId('refresh-catalog'))
  await screen.findByTestId('refresh-error')
  expect(useAppStore.getState().catalogStatus).toBe('ready')          // 决策④:不打翻现有目录
  expect(screen.queryByTestId('catalog-retry')).not.toBeInTheDocument()  // 无首载错误屏
})

test('刷新降级(degraded) → 目录更新 + 降级提示', async () => {
  const source = sourceOf([
    async () => ({ snapshot: SNAP() }),
    async () => ({ snapshot: SNAP({ generatedAt: 3000 }), degraded: 'Host 不可达' }),
  ])
  render(<App catalogSource={source} />)
  await screen.findByTestId('refresh-catalog')
  await userEvent.click(screen.getByTestId('refresh-catalog'))
  await screen.findByTestId('refresh-degraded')
})
```
（若 App.test 现有基建已 stub `fetch`（vitest.setup 永不 settle），注入 `catalogSource` 后首载不再依赖全局 fetch——这是 Task 5 抽象的直接收益。）

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run src/App.test.tsx` → 新 3 条 FAIL（无 `refresh-catalog`），现有全绿。

- [ ] **Step 3: 实现**

`src/components/AppShell.tsx`：props 加 `headerActions?: ReactNode`；header 行改：
```tsx
      <header className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: 'var(--color-line)' }}>
        <div className="font-semibold">OpenCLI App</div>
        <div className="flex items-center gap-3">
          {headerActions}
          <HealthPill />
        </div>
      </header>
```

`src/App.tsx`（最小 diff,保留现有其余逻辑）：
1. imports 增：`import { useEffect, useMemo, useState } from 'react'`、`import { snapshotCatalogSource, type CatalogSource } from './host'`、`import { validate } from './features/config/validation'`。
2. props：`export default function App({ host: injectedHost, catalogSource: injectedSource, mode = 'demo' }: { host?: HostBridge; catalogSource?: CatalogSource; mode?: 'demo' | 'connected' } = {})`；
   `const catalogSource = useMemo(() => injectedSource ?? snapshotCatalogSource(), [injectedSource])`。
3. 刷新 state：
```tsx
  const [refresh, setRefresh] = useState<{ state: 'idle' | 'refreshing' | 'error'; error?: string; degraded?: string; generatedAt?: number }>({ state: 'idle' })
```
4. `fetchCatalog`（首载）改用 source：
```tsx
  const fetchCatalog = () => {
    catalogSource.load()
      .then(({ snapshot, degraded }) => {
        setCommands(snapshot.commands)
        setRefresh((r) => ({ ...r, generatedAt: snapshot.generatedAt, degraded }))
        if (degraded) console.warn('[catalog]', degraded)
      })
      .catch((err) => setCatalogStatus('error', err instanceof Error ? err.message : String(err)))
  }
```
（useEffect 依赖数组补 `catalogSource`。）
5. 手动刷新（**独立于首载 catalogStatus**）：
```tsx
  const onRefreshCatalog = () => {
    setRefresh((r) => ({ ...r, state: 'refreshing', error: undefined, degraded: undefined }))
    catalogSource.load()
      .then(({ snapshot, degraded }) => {
        useAppStore.getState().setCommands(snapshot.commands)
        setRefresh({ state: 'idle', generatedAt: snapshot.generatedAt, degraded })
      })
      .catch((err) => setRefresh((r) => ({ ...r, state: 'error', error: err instanceof Error ? err.message : String(err) })))
  }
```
6. `executeSelected`（权威守卫；替换现 `onRun` 实现,函数名改掉、传给 CommandConfig 的 prop 不变）：
```tsx
  const executeSelected = (): boolean => {
    const s = useAppStore.getState()
    if (!s.selected) return false
    if (Object.keys(validate(s.selected, s.values)).length > 0) return false   // 权威再验(阻塞4)
    const runId = crypto.randomUUID()
    s.beginRun(runId)
    const argv = buildArgv(s.selected, s.values)
    void host.startCommand({ runId, commandKey: s.selected.command, argv })
      .catch((err) => useAppStore.getState().finishRun({ runId, at: Date.now(), outcome: 'error', error: normalizeHostError(err) }))
    return true
  }
```
7. 刷新控件（App 内组件,与 App 同文件）：
```tsx
function CatalogRefresh({ refresh, onRefresh }: {
  refresh: { state: 'idle' | 'refreshing' | 'error'; error?: string; degraded?: string; generatedAt?: number }
  onRefresh: () => void
}) {
  const count = useAppStore((s) => s.commands.length)
  return (
    <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
      {refresh.generatedAt !== undefined && (
        <span data-testid="catalog-meta">
          {count} 条 · {new Date(refresh.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新
        </span>
      )}
      {refresh.state === 'error' && (
        <span data-testid="refresh-error" title={refresh.error} style={{ color: 'var(--color-danger)' }}>刷新失败</span>
      )}
      {refresh.degraded && (
        <span data-testid="refresh-degraded" title={refresh.degraded} style={{ color: 'var(--color-warning)' }}>已降级：本地快照</span>
      )}
      <button data-testid="refresh-catalog" disabled={refresh.state === 'refreshing'} onClick={onRefresh}
        className="rounded-lg px-2 py-1 disabled:opacity-50"
        style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}>
        {refresh.state === 'refreshing' ? '刷新中…' : '刷新目录'}
      </button>
    </div>
  )
}
```
8. `<AppShell …>` 加 `headerActions={<CatalogRefresh refresh={refresh} onRefresh={onRefreshCatalog} />}`；`config={<CommandConfig onRun={executeSelected} />}`。

`src/main.tsx`：`<App host={hostSelection.host} catalogSource={hostSelection.catalogSource} mode={hostSelection.mode} />`。

- [ ] **Step 4: 跑确认通过 + 三门**

Run: `npx vitest run src/App.test.tsx` 全绿（现有 + 新 3）→ `npx tsc --noEmit && npm test && npm run build`。

- [ ] **Step 5: 提交**

```bash
git add src/App.tsx src/App.test.tsx src/components/AppShell.tsx src/main.tsx
git commit -m "feat(app): executeSelected 权威守卫 + 刷新控件(独立 refresh 态/失败不打翻目录/降级提示) + AppShell headerActions 槽"
```

---

### Task 8: RunPanel 按钮矩阵 + 错误详情 + CommandConfig 复制命令

**Files:**
- Modify: `src/features/runs/RunPanel.tsx`（复制/重跑/详情；新 prop `onRerun`）
- Modify: `src/features/config/CommandConfig.tsx`（preview 旁复制命令）
- Modify: `src/App.tsx`（`<RunPanel onCancel={onCancel} onRerun={executeSelected} />`）
- Test: `src/features/runs/RunPanel.test.tsx`、`src/features/config/CommandConfig.test.tsx`（末尾追加,先读现有基建）

**Interfaces:**
- Consumes: Task 1 `copyPayloadFor`/`CopyButton`；Task 7 `executeSelected`；`validate`；`commandPreview(cmd, values)`。
- Produces: testid：`copy-run`/`rerun-button`/`error-detail-toggle`/`error-detail`/`copy-command`。

- [ ] **Step 1: 追加失败测试**

`RunPanel.test.tsx` 末尾（现有文件顶部已有构造 run 进 store 的基建——先读复用其工厂；若无,按其现有惯用写法构造 `currentRun`）：
```tsx
describe('终态按钮矩阵与错误详情(块 B)', () => {
  // 按现有测试文件的 store 构造惯例摆 currentRun/selected/values;下述断言为规格
  test('succeeded → 「复制结构化结果」+「再次执行」', () => { /* 摆 succeeded run + selected 同命令 → 断言两按钮文案 */ })
  test('failed → 「复制日志」+「重试」;cancelled → 「重新执行」', () => { /* 同上矩阵 */ })
  test('点复制 → clipboard 收到 payload text', async () => { /* stub navigator.clipboard,断言 writeText 收到 JSON.stringify(result,null,2) */ })
  test('切走命令 → 重跑按钮隐藏', () => { /* selected 换成另一命令 → queryByTestId(rerun-button) null */ })
  test('validate 有错 → 重跑 disabled + title 提示', () => { /* selected.args 带 required 且 values 空 → disabled */ })
  test('点重跑 → onRerun 被调', async () => { /* onRerun=vi.fn(),点击断言 */ })
  test('error.detail 展开/收起', async () => { /* failed run 带 detail → 点 toggle 出现 error-detail,再点消失 */ })
  test('运行中不显示复制/重跑', () => { /* running 态 → 两按钮都 null */ })
})
```
> 本 task 的测试**必须写成真实断言**（上面注释是规格,不是允许留空——实现者展开为完整代码,复用现有文件的 store 摆置惯例;每条测试的断言点已在注释指明,不得弱化「切走命令隐藏」与「payload text 精确匹配」两条）。

`CommandConfig.test.tsx` 末尾：
```tsx
test('preview 旁复制命令按钮,text=commandPreview', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  useAppStore.setState({ selected: cmd, values: {}, currentRun: undefined })
  render(<CommandConfig onRun={() => {}} />)
  await userEvent.click(screen.getByTestId('copy-command'))
  expect(writeText).toHaveBeenCalledWith(commandPreview(cmd, {}))
})
```
（顶部补 `import { commandPreview } from '../../data/command'`。）

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run src/features/runs/RunPanel.test.tsx src/features/config/CommandConfig.test.tsx` → 新增 FAIL,现有绿。

- [ ] **Step 3: 实现**

`RunPanel.tsx`（最小 diff）：
1. imports 增：`import { useEffect, useState } from 'react'`（useEffect 新增）、`import { copyPayloadFor } from '../../data/copyPayload'`、`import { CopyButton } from '../../components/CopyButton'`、`import { validate } from '../config/validation'`。
2. 签名：`export function RunPanel({ onCancel, onRerun }: { onCancel: () => void; onRerun: () => void })`。
3. 订阅补：`const selected = useAppStore((s) => s.selected)`、`const values = useAppStore((s) => s.values)`；state 补 `const [detailOpen, setDetailOpen] = useState(false)`；`useEffect(() => { setDetailOpen(false) }, [run?.id])`（新 run 重置）。
4. 计算（`if (!run) return …` 之后）：
```tsx
  const terminal = run.state === 'succeeded' || run.state === 'failed' || run.state === 'cancelled'
  const payload = terminal ? copyPayloadFor(run) : null
  const rerunVisible = terminal && selected?.command === run.command.command
  const rerunErrors = rerunVisible && selected ? validate(selected, values) : {}
  const rerunDisabled = Object.keys(rerunErrors).length > 0
  const rerunLabel = run.state === 'succeeded' ? '再次执行' : run.state === 'failed' ? '重试' : '重新执行'
```
5. 头部按钮区（cancel 按钮同级,`{active && …}` 之后插入）：
```tsx
          {payload && <CopyButton label={payload.label} getText={() => payload.text} testid="copy-run" />}
          {rerunVisible && (
            <button data-testid="rerun-button" disabled={rerunDisabled} onClick={onRerun}
              title={rerunDisabled ? '参数校验未通过，请回表单修正' : undefined}
              className="rounded-lg px-3 py-1 text-sm disabled:opacity-50"
              style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}>
              {rerunLabel}
            </button>
          )}
```
6. 错误条替换为：
```tsx
          {run.error && (
            <div className="mb-2 rounded-lg p-2 text-sm" style={{ background: 'var(--color-canvas)', color: 'var(--color-danger)' }}>
              <div className="flex items-center justify-between gap-2">
                <span>{run.error.summary}</span>
                {run.error.detail && (
                  <button data-testid="error-detail-toggle" onClick={() => setDetailOpen((o) => !o)}
                    className="shrink-0 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
                    {detailOpen ? '详情 ▴' : '详情 ▾'}
                  </button>
                )}
              </div>
              {detailOpen && run.error.detail && (
                <pre data-testid="error-detail" className="mt-2 max-h-48 overflow-auto text-xs" style={{ color: 'var(--color-fg-dim)' }}>{run.error.detail}</pre>
              )}
            </div>
          )}
```

`CommandConfig.tsx`：imports 增 `CopyButton`；preview `<pre>` 外包一层：
```tsx
      <div className="mb-4">
        <pre className="mb-1 overflow-x-auto rounded-lg p-3 text-xs" style={{ background: 'var(--color-canvas)', color: 'var(--color-fg-dim)' }}>{commandPreview(selected, values)}</pre>
        <CopyButton label="复制命令" getText={() => commandPreview(selected, values)} testid="copy-command" />
      </div>
```
（原 `<pre className="mb-4 …">` 的 mb-4 移到外层 div。）

`App.tsx`：`runs={<RunPanel onCancel={onCancel} onRerun={executeSelected} />}`。

- [ ] **Step 4: 跑确认通过 + 三门**

Run: Step 2 命令全绿 → `npx tsc --noEmit && npm test && npm run build`。

- [ ] **Step 5: 提交**

```bash
git add src/features/runs/RunPanel.tsx src/features/runs/RunPanel.test.tsx src/features/config/CommandConfig.tsx src/features/config/CommandConfig.test.tsx src/App.tsx
git commit -m "feat(runs): 终态按钮矩阵(语境化复制+重跑三文案)+错误详情展开+复制命令——RE/06 状态机落地"
```

---

## 收尾（计划外置,controller 执行）

- whole-branch 最终评审(Opus,含「真实数据量级」裁决要求)→ 浏览器真机验收(connected 模式:刷新目录→新命令可跑;复制/重跑/详情)→ finishing-a-development-branch。
- 真机验收要点:`node server/index.mjs` + `npm run dev` + `?host=node`;点「刷新目录」断言 `/catalog` 200 且 policy 同步;拔 Host 再刷新 → 「已降级:本地快照」;demo 模式刷新走 snapshot。

## Self-review 记录

- Spec 覆盖:§3.1→T5/T7;§3.2→T7/T8;§3.3→T1/T8;§3.4→T8;§3.5→T7;§4→T2/T3/T4;§5→T6;§8 验收逐条对 T1-T8 有落点。
- 类型一致:`CopyableRun` 结构兼容 `CommandRun`(state/lines/result/error 同名同型);`CatalogLoadResult` T5 定义、T7 消费;`executeSelected` T7 产、T8 消费(`onRerun`);`activePolicy()` T4 内部。
- 占位符:T8 RunPanel 测试以「规格注释+必须展开为真实断言」显式标注,非留空(现有测试基建未读全,由实现者按仓内惯例展开,断言点全部点名)。
