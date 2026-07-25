# P0-C 块 C：健壮性·键盘·杂项清扫 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RE/04 三键键盘层 + HealthPill 三态生命周期 + appendOutput 常数优化 + server 杂项(seen 有界/manifest 惰性/同步 spawn 502/SSE 补发单测) + normalizeHostError 契约,P0-C 关账。

**Architecture:** 前端三层不变;`runPanelCollapsed` 提升 store(Esc/自动展开/×收起三需求汇聚);键盘经 App refs(searchInputRef/submitFormRef)复用现有提交流程;server 只动 run-manager 与 catalog-service 内部,冻结 run 契约零触碰。

**Tech Stack:** 同块 B。spec=`docs/specs/2026-07-25-p0-c-c-robustness-design.md`(v2,基准表在 §4)。

## Global Constraints（每 task 隐含）

- 冻结契约零触碰:`/start /cancel /events` 语义、SSE 形状、`runMachine.ts`、HostBridge 接口不动(SSE 只加测试)。
- Esc **只关不开**:优先级链 IME忽略→可编辑元素blur→面板展开则收起→已收起no-op;只 `setRunPanelCollapsed(true)` 永不 toggle(设计复审 P1-1)。
- Ctrl/Cmd+Enter 复用 CommandConfig 完整提交流程(字段错误显示+聚焦首错),**不直调裸 executeSelected**(P1-2)。
- appendOutput 口径=**常数优化非 O(1)**(不可变追加保留,原地 push 否决;基准 spec §4)(P1-3)。
- `seen` 重复判定必须 `active.has || seen.has`(验收条件①)。
- manifest resolver **每次 refresh 调用、失败不缓存**(验收条件②)。
- 提交门铁律:`npx tsc --noEmit && npm test && npm run build` 全链 && 通过才 commit;只 add 各 task 点名文件。
- 仓内文件先读再改,最小 diff。

---

### Task 1: store——appendOutput 快路径 + runPanelCollapsed 提升

**Files:** Modify `src/store/appStore.ts`、`src/features/runs/RunPanel.tsx`;Test `src/store/appStore.test.ts`、`src/features/runs/RunPanel.test.tsx`(末尾追加/最小调整)

**Interfaces:** Produces `runPanelCollapsed: boolean`、`setRunPanelCollapsed(v: boolean)`(T4 Esc 链消费);`beginRun` 置 `runPanelCollapsed: false`。

- [ ] **Step 1: 追加失败测试**(appStore.test.ts 末尾)
```ts
describe('runPanelCollapsed 提升(块 C)', () => {
  beforeEach(() => { useAppStore.setState(initialState, true); localStorage.clear() })
  test('beginRun 自动展开(新 run 重置收起态)', () => {
    useAppStore.getState().setRunPanelCollapsed(true)
    useAppStore.getState().selectCommand(cmd)
    useAppStore.getState().beginRun('r-x')
    expect(useAppStore.getState().runPanelCollapsed).toBe(false)
  })
  test('setRunPanelCollapsed 独立于 run 状态机', () => {
    useAppStore.getState().selectCommand(cmd)
    useAppStore.getState().beginRun('r-y')
    useAppStore.getState().setRunPanelCollapsed(true)
    expect(useAppStore.getState().currentRun?.state).toBe('starting')   // 纯视图 flag,不碰状态机
  })
})

test('appendOutput 单调快路径:100 事件顺序与内容等价', () => {
  useAppStore.getState().selectCommand(cmd); useAppStore.getState().beginRun('r-fast')
  for (let i = 0; i < 100; i++) {
    useAppStore.getState().appendOutput({ runId: 'r-fast', seq: i, at: i, stream: 'stdout', text: `l${i}` })
  }
  const lines = useAppStore.getState().currentRun!.lines
  expect(lines).toHaveLength(100)
  expect(lines.map((l) => l.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i))
})
```
（既有「按 seq 去重且乱序插入有序」「终态抑制」用例 = 慢路径回归护栏,必须仍绿。）

- [ ] **Step 2: 跑红** `npx vitest run src/store/appStore.test.ts` → runPanelCollapsed 两条红（action 不存在）;快路径条绿(行为等价)可接受。

- [ ] **Step 3: 实现**（先读两文件全文,最小 diff）

appStore.ts:
1. `AppState` 加 `runPanelCollapsed: boolean` 与 `setRunPanelCollapsed: (v: boolean) => void`。
2. store 实现加:`runPanelCollapsed: false,`、`setRunPanelCollapsed: (v) => set({ runPanelCollapsed: v }),`。
3. `beginRun` 的 `set({...})` 对象里加 `runPanelCollapsed: false,`（新 run 自动展开）。
4. `appendOutput` 整体替换为:
```ts
  appendOutput: (e) => set((s) => {
    if (!s.currentRun || s.currentRun.id !== e.runId || isTerminal(s.currentRun.state)) return s
    const lines = s.currentRun.lines
    const last = lines[lines.length - 1]
    // 快路径:seq 单调(P0-B 硬前提#3)时免 some/sort——数组恒有序,尾后新 seq 不可能重复。
    // 口径:剔除 some/sort 的常数优化(基准 8-13×@≤10k,spec §4),渐近仍 O(n²) 复制;不可变约定保留。
    let next: OutputEvent[]
    if (!last || e.seq > last.seq) {
      next = [...lines, e]
    } else if (lines.some((l) => l.seq === e.seq)) {
      return s
    } else {
      next = [...lines, e].sort((a, b) => a.seq - b.seq)
    }
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'OUTPUT' }), lines: next } }
  }),
```

RunPanel.tsx:局部 `const [collapsed, setCollapsed] = useState(false)` 删除,改:
```tsx
  const collapsed = useAppStore((s) => s.runPanelCollapsed)
  const setCollapsed = useAppStore((s) => s.setRunPanelCollapsed)
```
×按钮 `onClick={() => setCollapsed((c) => !c)}` 改 `onClick={() => setCollapsed(!collapsed)}`（×按钮保持 toggle;Esc 只写 true 在 T4）。`useState` import 若因此无其他消费则从 import 里移除(detailOpen 仍用,保留)。

- [ ] **Step 4: 全绿+三门**（RunPanel 既有「⑦b 收起」测试必须仍绿——行为同,状态源变 store;若其 beforeEach 未重置 store 的 collapsed,按现有重置惯例补 `runPanelCollapsed: false`。）

- [ ] **Step 5: 提交**
```bash
git add src/store/appStore.ts src/store/appStore.test.ts src/features/runs/RunPanel.tsx src/features/runs/RunPanel.test.tsx
git commit -m "feat(store): runPanelCollapsed 提升+beginRun 自动展开;appendOutput 单调快路径(常数优化,基准 spec §4)"
```

---

### Task 2: HealthPill 三态 + 请求生命周期 + a11y

**Files:** Modify `src/components/HealthPill.tsx`;Test `src/components/HealthPill.test.tsx`(先读,存在则改造,不存在则新建)

**Interfaces:** 无对外新接口;testid `health-pill` 不变。

- [ ] **Step 1: 测试**(改造/新建;关键用例)
```tsx
import { render, screen, waitFor, act } from '@testing-library/react'
import { HealthPill } from './HealthPill'
import { useAppStore } from '../store/appStore'

const initialState = useAppStore.getState()
beforeEach(() => { useAppStore.setState(initialState, true) })

test('demo 模式显示演示模式', () => {
  render(<HealthPill />)
  expect(screen.getByTestId('health-pill')).toHaveTextContent('演示模式')
})

test('connected 初态「检查中…」,首 ping 落定前不得显示已连接(消灭乐观默认)', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))   // 永不落定
  useAppStore.setState({ mode: 'connected' })
  render(<HealthPill />)
  expect(screen.getByTestId('health-pill')).toHaveTextContent('检查中…')
})

test('ping ok → 已连接;ping fail → Host 离线', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
  useAppStore.setState({ mode: 'connected' })
  const { unmount } = render(<HealthPill />)
  await waitFor(() => expect(screen.getByTestId('health-pill')).toHaveTextContent('已连接'))
  unmount()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
  render(<HealthPill />)
  await waitFor(() => expect(screen.getByTestId('health-pill')).toHaveTextContent('Host 离线'))
})

test('慢旧响应不倒灌(世代 latest-wins)', async () => {
  vi.useFakeTimers()
  try {
    let resolveSlow!: (v: { ok: boolean }) => void
    const slow = new Promise<{ ok: boolean }>((r) => { resolveSlow = r })
    const fetchMock = vi.fn()
      .mockReturnValueOnce(slow)                                  // 第 1 发:悬挂(将失败)
      .mockResolvedValue({ ok: true })                            // 之后:成功
    vi.stubGlobal('fetch', fetchMock)
    useAppStore.setState({ mode: 'connected' })
    render(<HealthPill />)
    await act(async () => { vi.advanceTimersByTime(5000) })       // 第 2 发发出并落定 online
    await act(async () => {})                                     // flush 微任务
    expect(screen.getByTestId('health-pill')).toHaveTextContent('已连接')
    resolveSlow({ ok: false })                                    // 旧响应姗姗来迟
    await act(async () => {})
    expect(screen.getByTestId('health-pill')).toHaveTextContent('已连接')   // 未被倒灌
  } finally { vi.useRealTimers() }
})

test('a11y:role=status + aria-live=polite', () => {
  render(<HealthPill />)
  const pill = screen.getByTestId('health-pill')
  expect(pill).toHaveAttribute('role', 'status')
  expect(pill).toHaveAttribute('aria-live', 'polite')
})
```
(若既有 HealthPill 测试断言乐观「已连接」初态,按新语义改为「检查中…」——这是行为修正,断言更新合法。fake timers 下 AbortController/fetch 交互若有 jsdom 兼容问题,以「世代守卫丢弃旧响应」为断言核心,abort 属加固。)

- [ ] **Step 2: 跑红**（初态「检查中…」对旧代码红——旧代码显「已连接」）。

- [ ] **Step 3: 实现**（整体替换 HealthPill.tsx 主体逻辑,保留 DEFAULT_NODE_HOST_URL/PING_INTERVAL_MS,新增 `PING_TIMEOUT_MS = 2000`）
```tsx
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/appStore'

const DEFAULT_NODE_HOST_URL = 'http://127.0.0.1:43117'
const PING_INTERVAL_MS = 5000
const PING_TIMEOUT_MS = 2000

type HealthState = 'checking' | 'online' | 'offline'

export function HealthPill() {
  const mode = useAppStore((s) => s.mode)
  const demo = mode === 'demo'
  // 三态:首 ping 落定前显「检查中…」,消灭乐观默认的假「已连接」窗口(块 C 设计 §3)
  const [state, setState] = useState<HealthState>('checking')
  const genRef = useRef(0)

  useEffect(() => {
    if (mode !== 'connected') return
    setState('checking')
    const base = (import.meta.env.VITE_NODE_HOST_URL as string | undefined) ?? DEFAULT_NODE_HOST_URL
    let inflight: AbortController | undefined

    const ping = () => {
      const gen = ++genRef.current
      inflight?.abort()                    // 上一发未归即作废,防重叠
      const ctrl = new AbortController()
      inflight = ctrl
      const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS)
      fetch(`${base}/health`, { signal: ctrl.signal })
        .then((res) => { if (gen === genRef.current) setState(res.ok ? 'online' : 'offline') })
        .catch(() => { if (gen === genRef.current) setState('offline') })   // 超时 abort 也判离线
        .finally(() => clearTimeout(timer))
    }

    ping()
    const id = setInterval(ping, PING_INTERVAL_MS)
    return () => {
      genRef.current += 1                  // 卸载/切模式:在途响应全部过期
      inflight?.abort()
      clearInterval(id)
    }
  }, [mode])

  const label = demo ? '演示模式' : state === 'checking' ? '检查中…' : state === 'online' ? '已连接' : 'Host 离线'
  const color = demo ? 'var(--color-warning)' : state === 'checking' ? 'var(--color-fg-dim)' : state === 'online' ? 'var(--color-success)' : 'var(--color-danger)'

  return (
    <span
      data-testid="health-pill"
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-lg px-3 py-1 text-sm"
      style={{ background: 'var(--color-panel)', color }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 8, background: 'currentColor' }} />
      {label}
    </span>
  )
}
```

- [ ] **Step 4: 全绿+三门**  - [ ] **Step 5: 提交**
```bash
git add src/components/HealthPill.tsx src/components/HealthPill.test.tsx
git commit -m "feat(health): 三态 checking/online/offline+ping 世代 latest-wins+2s 超时 abort+role=status(设计复审 P2-4)"
```

---

### Task 3: App——normalizeHostError 契约 + executeSelected 三守卫

> **合并后复审 F2 补记**：本 task 的三分支之上另加 `HostRequestError` 分支（**必须排在 `instanceof Error` 之前**，它继承 Error，放后即死代码）——Host 实现拒绝请求时抛 `HostRequestError` 携结构化 summary/detail，不得拼进 message。契约见 spec §6.1，护栏是 NodeBridge→App→`currentRun.error` 跨层集成测试（本 task 当时只做 App 层单测，是缺口根因）。

**Files:** Modify `src/App.tsx`;Test `src/App.test.tsx`(末尾追加)

**Interfaces:** Produces `export function normalizeHostError(e: unknown, context: 'start' | 'cancel')`(导出供测);executeSelected 守卫(T4 键盘消费);Consumes `isTerminal` 需从 store 导出或本地实现——**appStore.ts 的 `isTerminal` 当前未导出:在 appStore.ts 给它加 `export`**,App import。

- [ ] **Step 1: 追加失败测试**(App.test.tsx 末尾)
```tsx
import { normalizeHostError } from './App'

describe('normalizeHostError 契约(块 C)', () => {
  test('Error → message+stack;空 message 用 context fallback', () => {
    const e = new Error('boom')
    expect(normalizeHostError(e, 'start')).toEqual({ summary: 'boom', detail: e.stack })
    expect(normalizeHostError(new Error(''), 'cancel').summary).toBe('取消请求失败')
  })
  test('结构化 {summary,detail} 透传,不再退化 [object Object]', () => {
    expect(normalizeHostError({ summary: '策略拒绝', detail: 'HTTP 403' }, 'start'))
      .toEqual({ summary: '策略拒绝', detail: 'HTTP 403' })
  })
  test('其余类型 → context fallback + String(e)', () => {
    expect(normalizeHostError(42, 'cancel')).toEqual({ summary: '取消请求失败', detail: '42' })
    expect(normalizeHostError(42, 'start')).toEqual({ summary: '任务启动失败', detail: '42' })
  })
})
```

- [ ] **Step 2: 跑红**（未导出/签名不符）。

- [ ] **Step 3: 实现**
1. appStore.ts:`function isTerminal` 前加 `export`。
2. App.tsx 顶部 import 加 `isTerminal`(from './store/appStore')。
3. `normalizeHostError` 整体替换并导出:
```tsx
export function normalizeHostError(e: unknown, context: 'start' | 'cancel'): { summary: string; detail?: string } {
  const fallback = context === 'cancel' ? '取消请求失败' : '任务启动失败'
  if (e && typeof e === 'object' && !(e instanceof Error)) {
    const o = e as { summary?: unknown; detail?: unknown }
    if (typeof o.summary === 'string') {
      return { summary: o.summary, detail: typeof o.detail === 'string' ? o.detail : undefined }
    }
  }
  if (e instanceof Error) return { summary: e.message || fallback, detail: e.stack }
  return { summary: fallback, detail: String(e) }
}
```
4. 两处调用带 context:`executeSelected` 的 catch → `normalizeHostError(err, 'start')`;`onCancel` 的 catch → `normalizeHostError(err, 'cancel')`。
5. `executeSelected` 守卫链改为(spec §1.4 顺序):
```tsx
    const s = useAppStore.getState()
    if (s.catalogStatus !== 'ready') return false
    if (s.currentRun && !isTerminal(s.currentRun.state)) return false   // 键盘路径绕过按钮 disabled,权威兜底
    if (!s.selected) return false
    if (Object.keys(validate(s.selected, s.values)).length > 0) return false
```

- [ ] **Step 4: 全绿+三门**  - [ ] **Step 5: 提交**
```bash
git add src/App.tsx src/App.test.tsx src/store/appStore.ts
git commit -m "feat(app): normalizeHostError 输入契约+start/cancel 语境(P2-5);executeSelected 三守卫收口(键盘路径兜底)"
```

---

### Task 4: 键盘层——三键 + refs 接线

**Files:** Modify `src/App.tsx`、`src/features/nav/SiteCommandNav.tsx`、`src/features/config/CommandConfig.tsx`;Test `src/App.test.tsx`(末尾追加)

**Interfaces:** Consumes T1 `runPanelCollapsed/setRunPanelCollapsed`、T3 守卫;SiteCommandNav 新 prop `searchRef?: React.Ref<HTMLInputElement>`;CommandConfig 新 prop `registerSubmit?: (fn: (() => void) | null) => void`。

- [ ] **Step 1: 追加失败测试**(App.test.tsx 末尾;`fireEvent` 需在 RTL import 补上)
```tsx
describe('键盘层(RE/04 三键,块 C)', () => {
  const CMD_REQ: CommandManifest = {
    command: 'k/run', site: 'k', name: 'run', description: '', access: 'read', browser: false,
    args: [{ name: 'must', type: 'str', required: true }],
  }
  const keydown = (init: KeyboardEventInit) => fireEvent.keyDown(window, init)

  test('Ctrl+K 聚焦搜索框(ref 路径)', async () => {
    render(<App />)
    await screen.findByTestId('nav-search')
    keydown({ key: 'k', ctrlKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('nav-search'))
  })

  test('Ctrl+Enter 非法表单 → 显示字段错误(与点运行一致),不静默', async () => {
    render(<App />)
    await screen.findByTestId('nav-search')
    act(() => { useAppStore.setState({ commands: [CMD_REQ], catalogStatus: 'ready' }); useAppStore.getState().selectCommand(CMD_REQ) })
    keydown({ key: 'Enter', ctrlKey: true })
    expect(await screen.findByText('此字段必填')).toBeInTheDocument()
    expect(useAppStore.getState().currentRun).toBeUndefined()          // 未起跑
  })

  test('Ctrl+Enter 合法表单 → 起跑;活跃 run 期间再按 → 不二次起跑(守卫)', async () => {
    render(<App />)
    await screen.findByTestId('nav-search')
    const ok: CommandManifest = { ...CMD_REQ, args: [] }
    act(() => { useAppStore.setState({ commands: [ok], catalogStatus: 'ready' }); useAppStore.getState().selectCommand(ok) })
    keydown({ key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(useAppStore.getState().currentRun).toBeDefined())
    const firstId = useAppStore.getState().currentRun!.id
    keydown({ key: 'Enter', ctrlKey: true })                           // running 中
    expect(useAppStore.getState().currentRun!.id).toBe(firstId)        // 无第二个 run
  })

  test('Esc 链:聚焦→blur;展开→收起;已收起→no-op 不重开(P1-1)', async () => {
    render(<App />)
    const search = await screen.findByTestId('nav-search')
    search.focus()
    keydown({ key: 'Escape' })
    expect(document.activeElement).not.toBe(search)                    // ② blur
    const ok: CommandManifest = { command: 'k/r2', site: 'k', name: 'r2', description: '', access: 'read', browser: false, args: [] }
    act(() => { useAppStore.setState({ commands: [ok], catalogStatus: 'ready' }); useAppStore.getState().selectCommand(ok); useAppStore.getState().beginRun('r-esc') })
    expect(useAppStore.getState().runPanelCollapsed).toBe(false)       // beginRun 自动展开
    keydown({ key: 'Escape' })
    expect(useAppStore.getState().runPanelCollapsed).toBe(true)        // ③ 收起
    keydown({ key: 'Escape' })
    expect(useAppStore.getState().runPanelCollapsed).toBe(true)        // ④ no-op,永不重开
  })

  test('IME composing 时 Esc 忽略', async () => {
    render(<App />)
    const search = await screen.findByTestId('nav-search')
    search.focus()
    keydown({ key: 'Escape', isComposing: true })
    expect(document.activeElement).toBe(search)                        // ① 未 blur
  })
})
```

- [ ] **Step 2: 跑红**。

- [ ] **Step 3: 实现**

App.tsx:
1. import 补 `useCallback`(如未用则 useRef 足矣,按实现取舍)、`isTerminal` 已有(T3)。
2. 组件内:
```tsx
  const searchInputRef = useRef<HTMLInputElement>(null)
  const submitFormRef = useRef<(() => void) | null>(null)
  const registerSubmit = useCallback((fn: (() => void) | null) => { submitFormRef.current = fn }, [])
```
3. 键盘 effect(一次挂载):
```tsx
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (mod && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault()                                   // 压掉浏览器默认(地址栏搜索)
        searchInputRef.current?.focus()
        return
      }
      if (mod && event.key === 'Enter') {
        event.preventDefault()
        submitFormRef.current?.()                                // 完整提交流程:字段错误显示+聚焦首错(P1-2)
        return
      }
      if (event.key === 'Escape') {
        if (event.isComposing) return                            // ① IME
        const el = document.activeElement as HTMLElement | null
        const editable = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
        if (editable) { el.blur(); return }                      // ② 取消聚焦
        const s = useAppStore.getState()
        if (s.currentRun && !s.runPanelCollapsed) s.setRunPanelCollapsed(true)   // ③ 只收起(P1-1)
        // ④ 已收起/无 run:no-op —— 永不 toggle、永不展开
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
```
4. JSX:`<SiteCommandNav searchRef={searchInputRef} />`、`<CommandConfig onRun={executeSelected} registerSubmit={registerSubmit} />`。

SiteCommandNav.tsx:props 加 `searchRef`:
```tsx
export function SiteCommandNav({ searchRef }: { searchRef?: React.Ref<HTMLInputElement> } = {}) {
```
搜索 `<input` 加 `ref={searchRef}`。(`import type { Ref } from 'react'` 按仓内风格。)

CommandConfig.tsx:props 加 `registerSubmit`;**hooks 必须在 `if (!selected) return` 早退之前**:
```tsx
  const handleRunRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!registerSubmit) return
    registerSubmit(() => handleRunRef.current?.())
    return () => registerSubmit(null)
  }, [registerSubmit])
```
早退分支置空:`if (!selected) { handleRunRef.current = null; return <div ...>…</div> }`;`handleRun` 定义后一行 `handleRunRef.current = handleRun`(渲染期给 ref 赋值,合法)。

> **⚠️ 最终修订(P3 清理轮,以此为准——勿按上一段恢复反模式)**:渲染期写 ref 是 React 反模式(评审 M-2),已改为
> `useEffect(() => { handleRunRef.current = selected ? handleRun : null })`(无依赖数组,commit 后同步最新闭包),
> 早退分支不再置 null(改由 `handleRun` 内 `if (!cmd) return` 兜安全 no-op);同时 `handleRun` **单快照读实时 store**
> (`const s = useAppStore.getState()`,`cmd`/`values`/`currentRun` 同源取),不再依赖渲染期闭包。
> 现行实现见 `src/features/config/CommandConfig.tsx`,契约理由见块 C spec 与 ledger 的 P3 清理章节。

- [ ] **Step 4: 全绿+三门**  - [ ] **Step 5: 提交**
```bash
git add src/App.tsx src/App.test.tsx src/features/nav/SiteCommandNav.tsx src/features/config/CommandConfig.tsx
git commit -m "feat(keyboard): RE/04 三键——Ctrl/Cmd+K 聚焦搜索(ref)/Ctrl/Cmd+Enter 复用完整提交流程/Esc 四级关闭链只关不开"
```

---

### Task 5: server——run-manager `seen` 有界

**Files:** Modify `server/run-manager.mjs`;Test `server/run-manager.test.mjs`(先读现有 harness,末尾追加)

- [ ] **Step 1: 追加失败测试**(复用现有 FakeChild/构造惯例;两条)
```js
it('seen 有界:cap 内驱逐最旧,被驱逐 id 可重用(重放保护有界,UUID 下碰撞理论级)', () => {
  // maxSeenRunIds: 2;依次完成 3 个 run(每个 start 后让 child close 释放 active)
  // → 第 1 个 runId 已被驱逐:再 start 同 id 不抛 409
})

it('cap 小于并发数:活跃 run 即使被驱逐出 seen 也不能重复启动(active.has 兜底)', () => {
  // maxSeenRunIds: 1, maxConcurrentRuns: 2;start A(在途不 close),start B → A 被驱逐出 seen
  // → 再 start A → 仍 409(Duplicate runId)
})
```
(测试体按现有 run-manager.test 惯例展开为真实代码——start 请求形状/FakeChild 释放方式以现有用例为准;两条断言语义不得弱化。)

- [ ] **Step 2: 跑红**(第一条对旧代码红:无界 seen 永远 409;第二条旧代码绿[无界]——它是新语义的守卫,红绿判定以第一条为准,第二条跑通即可)。

- [ ] **Step 3: 实现**(run-manager.mjs 最小 diff)
1. 构造参数与赋值加 `maxSeenRunIds = 1000`。
2. `start()` 开头重复判定改:
```js
    if (this.active.has(request.runId) || this.seen.has(request.runId)) {
      throw new RunManagerError(409, `Duplicate runId: ${request.runId}`)
    }
```
3. `this.seen.add(request.runId)` 之后加:
```js
    // 有界最近集:插入序驱逐最旧(Set 迭代序=插入序);在途 run 由 active.has 兜底,驱逐不影响其去重
    if (this.seen.size > this.maxSeenRunIds) {
      this.seen.delete(this.seen.values().next().value)
    }
```

- [ ] **Step 4: 全绿+三门**  - [ ] **Step 5: 提交**
```bash
git add server/run-manager.mjs server/run-manager.test.mjs
git commit -m "fix(server): seen 有界化(maxSeenRunIds=1000 插入序驱逐)+active.has 兜底——长期运行内存不再无界增长"
```

---

### Task 6: server——manifest 惰性 + 同步 spawn 502 + SSE 补发单测

**Files:** Modify `server/catalog-service.mjs`、`server/index.mjs`;Test `server/catalog-service.test.mjs`、`server/host-server.test.mjs`(末尾追加)

- [ ] **Step 1: 追加失败测试**

catalog-service.test.mjs(fixture 的 `manifestPath: 'C:/fixture/cli-manifest.json'` 全量改为 `resolveManifest: () => 'C:/fixture/cli-manifest.json'`,现有用例随签名迁移):
```js
it('manifest 惰性:resolver 每次 refresh 调用,失败不缓存,文件出现后自愈(验收条件②)', async () => {
  let available = false
  const { service, children } = setup({ resolveManifest: () => { if (!available) throw new Error('ENOENT'); return 'C:/fixture/cli-manifest.json' } })
  const p1 = service.refresh(); emitSuccess(children[0])
  await expect(p1).rejects.toMatchObject({ statusCode: 500 })
  expect(service.current()).toBeUndefined()                       // 失败不缓存也不落状态
  available = true
  const p2 = service.refresh(); emitSuccess(children[1])
  await expect(p2).resolves.toMatchObject({ schemaVersion: 1 })   // 自愈
})

it('同步 spawn throw → 502(状态码矩阵补齐)', async () => {
  const { service } = setup({ spawnImpl: () => { throw new Error('EPERM sync') } })
  await expect(service.refresh()).rejects.toMatchObject({ statusCode: 502 })
})
```
host-server.test.mjs(SSE 补发,HTTP 级;写 `readSseEvents(response, n)` 局部 helper 读满 n 条事件即返回并 cancel):
```js
it('SSE Last-Event-ID 断线中间重连:补发严格 id>Last-Event-ID、有序、无重无漏(验收条件③)', async () => {
  // 1) setup;POST /start;FakeChild 依次 emit 3 段 stdout + close(0) → broker 积累 output×3 + done×1
  // 2) 第一条 /events 连接只读前 2 个事件(readSseEvents(res,2)),记 lastId=第 2 条的 id,cancel 断开
  // 3) 带 Last-Event-ID: lastId 重连 → 读到 done 为止
  // 4) 断言:补发全部 id > lastId;id 严格递增;断前 2 条 ∪ 补发 = 完整全集(按 id 对照,无重无漏)
})
```
(SSE 帧含 `id:` 行——现有 readSseUntilDone 未提取 id,新 helper 解析 `^id: (\d+)$`;测试体展开为真实断言。)

- [ ] **Step 2: 跑红**(签名迁移后现有用例先修绿,再看新三条红)。

- [ ] **Step 3: 实现**(catalog-service.mjs 最小 diff)
1. 参数 `manifestPath` → `resolveManifest`(`() => string`);存 `this→resolveManifest`。
2. `doRefresh` 里 manifest 读取段前加:
```js
    let manifestPath
    try {
      manifestPath = resolveManifest()          // 每次 refresh 现解析,失败不缓存(验收条件②)
    } catch (error) {
      throw new CatalogServiceError(500, 'Failed to resolve cli-manifest.json', error instanceof Error ? error.message : String(error))
    }
```
(`readOpencliVersion` 改为接受 `manifestPath` 参数。)
3. `runList` 的 spawn 调用包同步 try/catch:
```js
    let child
    try {
      child = spawnImpl(process.execPath, [opencliEntry, 'list', '-f', 'json'], { shell: false, windowsHide: true })
    } catch (error) {
      rejectPromise(new CatalogServiceError(502, 'Failed to spawn opencli list', error instanceof Error ? error.message : String(error)))
      return
    }
```
4. index.mjs:`createCatalogService({ opencliEntry, resolveManifest: () => resolveManifestPath(opencliEntry) })` ——启动期不再急切求值(M3:manifest 缺失 Host 照常启动,仅刷新 500)。

- [ ] **Step 4: 全绿+三门**  - [ ] **Step 5: 提交**
```bash
git add server/catalog-service.mjs server/catalog-service.test.mjs server/index.mjs server/host-server.test.mjs
git commit -m "fix(server): manifest 惰性解析(每次 refresh,失败不缓存可自愈,M3)+同步 spawn→502+SSE Last-Event-ID 补发 HTTP 级单测(P0-B 遗留)"
```

---

### Task 7(controller 自做): 文档消歧 + 收尾

- master 设计 §3:BrowserBridge 验证移出 P0-B(对齐专项规格后置口径)。
- ledger 收口;whole-branch 终审(Opus)→ 真机抽验(键盘三键+HealthPill 三态)→ finishing-branch。

## Self-review 记录

- Spec 覆盖:§1→T3/T4;§2→T1;§3→T2;§4→T1;§5.1→T5;§5.2/5.3→T6;§5.4→T6;§6→T3;§7→T7。验收 §9 逐条有落点。
- 类型一致:`runPanelCollapsed/setRunPanelCollapsed` T1 产 T4 消费;`isTerminal` T3 加 export、T3/T4 消费;`registerSubmit/searchRef` T4 内自洽;`resolveManifest` T6 签名迁移含全部 fixture。
- 占位符:T5/T6 两处测试以「规格注释+断言点点名」标注(现有 harness 未读全),实现者展开为真实断言,弱化即打回;其余步骤全代码。
