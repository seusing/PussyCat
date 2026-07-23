# OpenCLIApp 复刻 P0-A（最小纵向切片）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个由真实 `opencli list` catalog 驱动、宿主用确定性 mock 的三栏命令工作台最小闭环——选命令→填参→运行→流式输出→成功/失败/取消三终态。

**Architecture:** 前端 Vite+React+TS 单页；数据来自构建期 `sync-catalog` 快照；UI 只依赖冻结的 `HostBridge` 接口，P0-A 用 `deterministicMockHost` 实现，后续 P0-B 无缝换 Node Host。状态集中在单一 Zustand store，运行状态由纯函数状态机驱动。

**Tech Stack:** Vite 6 · React 18 · TypeScript(strict) · Tailwind v4(`@tailwindcss/vite`) · CSS Variables(design token) · Zustand 5 · Vitest 2 + @testing-library/react。

## Global Constraints

以下为项目级约束，每个 task 隐含遵守（值逐字来自 spec）：

- 运行环境 Node ≥ 25.7.0；包管理器 npm。
- 数据源 `opencli list -f json`（解析前 strip UTF-8 BOM `﻿`）；包内 `cli-manifest.json` 按 `site+name` 补 `navigateBefore` / `defaultWindowMode` / `type` / `modulePath`。
- 一切由 catalog 驱动，**绝不硬编码任何单条命令的页面**。
- HostBridge 七条语义：① `done` 每 `runId` 恰好一次；② `cancel` 幂等；③ cancel 与自然结束竞态时采用真实终态；④ 启动失败/退出码/超时/终止统一收敛到 `done{outcome}`；⑤ `seq` 单调递增；⑥ UI 收起（×）只改可见性不改运行状态；⑦ 历史/展示中敏感参数脱敏。
- 执行（P0-B 起）：`spawn(bin, argv, { shell: false })`，命令预览由 argv **单独转义**生成，**绝不拼 shell 字符串**。
- daemon 端口动态发现，不固化 19825/19826。
- P0 全程浏览器/Node，**不落 exe**（本机新 exe 有 SxS 14001 风险）。
- TDD；小步频繁提交；commit message 用中文，结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## File Structure

```
opencli-app-clone/
├─ package.json / vite.config.ts / tsconfig.json / index.html
├─ public/catalog.snapshot.json          # Task 3 产出
├─ scripts/sync-catalog.mjs              # Task 3
├─ src/
│  ├─ main.tsx / App.tsx / index.css / vitest.setup.ts   # Task 1 / 8
│  ├─ data/
│  │  ├─ types.ts                        # Task 2：领域类型
│  │  ├─ inputKind.ts                    # Task 2
│  │  ├─ normalize.ts                    # Task 3：list 归一化 + manifest 补字段
│  │  ├─ catalog.ts                      # Task 4：加载/搜索/分组
│  │  └─ command.ts                      # Task 6：buildArgv / commandPreview
│  ├─ host/
│  │  ├─ types.ts                        # Task 5：HostBridge 契约
│  │  └─ mockHost.ts                     # Task 5：deterministicMockHost
│  ├─ store/
│  │  ├─ runMachine.ts                   # Task 7：状态机纯函数
│  │  └─ appStore.ts                     # Task 7：zustand 四切片 + 脱敏
│  ├─ components/
│  │  ├─ AppShell.tsx / HealthPill.tsx   # Task 8
│  ├─ features/
│  │  ├─ nav/SiteCommandNav.tsx          # Task 9
│  │  ├─ config/{CommandConfig,DynamicField,validation}.tsx|ts   # Task 10
│  │  └─ runs/{RunPanel,StreamLog,ResultsTable}.tsx              # Task 11
```

每个 `*.ts(x)` 旁放同名 `*.test.ts(x)`。

---

### Task 1: 工程基线（Vite + React + TS + Tailwind v4 + Zustand + Vitest）

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`
- Create: `src/main.tsx`, `src/App.tsx`, `src/index.css`, `src/vitest.setup.ts`
- Test: `src/App.test.tsx`

**Interfaces:**
- Produces: 可 `npm run dev` / `build` / `test` 的基线；`App` 默认导出组件；Tailwind v4 + CSS 变量 token 就绪。

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "opencli-app-clone",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "sync-catalog": "node scripts/sync-catalog.mjs"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zustand": "^5.0.2"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.3",
    "vite": "^6.0.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: 创建 `vite.config.ts`（react + tailwind + vitest 一处配齐）**

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/vitest.setup.ts'],
  },
})
```

- [ ] **Step 3: 创建 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "scripts"]
}
```

- [ ] **Step 4: 创建 `index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenCLI App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 创建 `src/index.css`（Tailwind v4 + design token 走 CSS 变量）**

```css
@import "tailwindcss";

@theme {
  --color-canvas: #0f1115;
  --color-panel: #171a21;
  --color-hover: #1f2430;
  --color-line: #262c38;
  --color-fg: #e6e9ef;
  --color-fg-dim: #9aa4b2;
  --color-accent: #4f8cff;
  --color-success: #3fb950;
  --color-warning: #d29922;
  --color-danger: #f85149;
}

:root { color-scheme: dark; }
html, body, #root { height: 100%; }
body { margin: 0; background: var(--color-canvas); color: var(--color-fg); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
```

- [ ] **Step 6: 创建 `src/vitest.setup.ts`**

```ts
import '@testing-library/jest-dom'
```

- [ ] **Step 7: 创建 `src/App.tsx`（占位，Task 8 替换）**

```tsx
export default function App() {
  return <div data-testid="app-root">OpenCLI App</div>
}
```

- [ ] **Step 8: 创建 `src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 9: 写冒烟测试 `src/App.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react'
import App from './App'

test('renders app root', () => {
  render(<App />)
  expect(screen.getByTestId('app-root')).toBeInTheDocument()
})
```

- [ ] **Step 10: 安装依赖并验证**

Run: `npm install`
Run: `npm test`
Expected: 1 passed（App smoke）
Run: `npm run build`
Expected: 构建成功，产出 `dist/`

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: Vite/React/TS/Tailwind/Zustand/Vitest 工程基线 + App 冒烟"
```

---

### Task 2: 领域类型 + `inputKind` 归一化

**Files:**
- Create: `src/data/types.ts`
- Create: `src/data/inputKind.ts`
- Test: `src/data/inputKind.test.ts`

**Interfaces:**
- Produces: `CommandManifest`、`ManifestArg`、`CatalogSnapshot`、`InputKind` 类型；`inputKind(arg: ManifestArg): InputKind`。

- [ ] **Step 1: 写 `src/data/types.ts`**

```ts
export type AccessKind = 'read' | 'write'

export type ManifestArg = {
  name: string
  type: 'str' | 'string' | 'int' | 'number' | 'float' | 'bool' | 'boolean'
  required?: boolean
  help?: string
  default?: string | number | boolean
  choices?: Array<string | { label: string; value: string }>
  positional?: boolean
  valueRequired?: boolean
}

export type CommandManifest = {
  command: string            // "site/name"，list 主键
  site: string
  name: string
  description: string
  access: AccessKind
  strategy?: string
  browser: boolean
  args: ManifestArg[]
  columns?: string[]
  domain?: string
  aliases?: string[]
  example?: string
  defaultFormat?: string
  // 由包内 manifest 补映射：
  navigateBefore?: boolean | string
  defaultWindowMode?: 'foreground' | 'background' | string
  type?: string
  modulePath?: string
}

export type CatalogSnapshot = {
  schemaVersion: 1
  generatedAt: number
  opencliVersion: string
  source: string
  listSha256: string
  manifestSha256: string
  commands: CommandManifest[]
}

export type InputKind = 'text' | 'number' | 'switch' | 'select'
```

- [ ] **Step 2: 写失败测试 `src/data/inputKind.test.ts`**

```ts
import { inputKind } from './inputKind'
import type { ManifestArg } from './types'

const arg = (p: Partial<ManifestArg>): ManifestArg => ({ name: 'a', type: 'str', ...p })

test('choices -> select（优先级最高）', () => {
  expect(inputKind(arg({ type: 'str', choices: ['a', 'b'] }))).toBe('select')
})
test('bool/boolean -> switch', () => {
  expect(inputKind(arg({ type: 'bool' }))).toBe('switch')
  expect(inputKind(arg({ type: 'boolean' }))).toBe('switch')
})
test('int/number/float -> number', () => {
  expect(inputKind(arg({ type: 'int' }))).toBe('number')
  expect(inputKind(arg({ type: 'number' }))).toBe('number')
  expect(inputKind(arg({ type: 'float' }))).toBe('number')
})
test('str/string -> text（兜底）', () => {
  expect(inputKind(arg({ type: 'str' }))).toBe('text')
  expect(inputKind(arg({ type: 'string' }))).toBe('text')
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/data/inputKind.test.ts`
Expected: FAIL（`inputKind` 未定义）

- [ ] **Step 4: 写实现 `src/data/inputKind.ts`**

```ts
import type { ManifestArg, InputKind } from './types'

export function inputKind(arg: ManifestArg): InputKind {
  if (arg.choices?.length) return 'select'
  if (arg.type === 'bool' || arg.type === 'boolean') return 'switch'
  if (arg.type === 'int' || arg.type === 'number' || arg.type === 'float') return 'number'
  return 'text'
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/data/inputKind.test.ts`
Expected: 4 passed

- [ ] **Step 6: Commit**

```bash
git add src/data/types.ts src/data/inputKind.ts src/data/inputKind.test.ts
git commit -m "feat(data): 领域类型 + inputKind 参数类型归一化"
```

---

### Task 3: list 归一化 + manifest 补字段 + `sync-catalog` 脚本

**Files:**
- Create: `src/data/normalize.ts`
- Test: `src/data/normalize.test.ts`
- Create: `scripts/sync-catalog.mjs`

**Interfaces:**
- Consumes: `CommandManifest`（Task 2）。
- Produces: `stripBom(s: string): string`；`mergeManifestFields(list: CommandManifest[], manifest: RawManifestCmd[]): CommandManifest[]`；`RawManifestCmd` 类型。脚本产出 `public/catalog.snapshot.json`。

- [ ] **Step 1: 写失败测试 `src/data/normalize.test.ts`**

```ts
import { stripBom, mergeManifestFields } from './normalize'
import type { CommandManifest } from './types'

test('stripBom 去除开头 BOM', () => {
  expect(stripBom('﻿[]')).toBe('[]')
  expect(stripBom('[]')).toBe('[]')
})

test('mergeManifestFields 按 site+name 补 navigateBefore/defaultWindowMode/type/modulePath', () => {
  const list: CommandManifest[] = [
    { command: '12306/login', site: '12306', name: 'login', description: '', access: 'write', browser: true, args: [] },
  ]
  const manifest = [
    { site: '12306', name: 'login', navigateBefore: false, defaultWindowMode: 'foreground', type: 'js', modulePath: '12306/auth.js' },
    { site: 'other', name: 'x', navigateBefore: true },
  ]
  const merged = mergeManifestFields(list, manifest)
  expect(merged[0].navigateBefore).toBe(false)
  expect(merged[0].defaultWindowMode).toBe('foreground')
  expect(merged[0].type).toBe('js')
  expect(merged[0].modulePath).toBe('12306/auth.js')
})

test('mergeManifestFields 对没有 manifest 对应项的命令保持原样', () => {
  const list: CommandManifest[] = [
    { command: 'baidubaike/search', site: 'baidubaike', name: 'search', description: '', access: 'read', browser: true, args: [] },
  ]
  const merged = mergeManifestFields(list, [])
  expect(merged[0].navigateBefore).toBeUndefined()
  expect(merged[0].site).toBe('baidubaike')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/data/normalize.test.ts`
Expected: FAIL（`stripBom`/`mergeManifestFields` 未定义）

- [ ] **Step 3: 写实现 `src/data/normalize.ts`**

```ts
import type { CommandManifest } from './types'

export type RawManifestCmd = {
  site: string
  name: string
  navigateBefore?: boolean | string
  defaultWindowMode?: string
  type?: string
  modulePath?: string
}

export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

export function mergeManifestFields(
  list: CommandManifest[],
  manifest: RawManifestCmd[],
): CommandManifest[] {
  const byKey = new Map<string, RawManifestCmd>()
  for (const m of manifest) byKey.set(`${m.site}/${m.name}`, m)
  return list.map((cmd) => {
    const m = byKey.get(`${cmd.site}/${cmd.name}`)
    if (!m) return cmd
    return {
      ...cmd,
      navigateBefore: cmd.navigateBefore ?? m.navigateBefore,
      defaultWindowMode: cmd.defaultWindowMode ?? m.defaultWindowMode,
      type: cmd.type ?? m.type,
      modulePath: cmd.modulePath ?? m.modulePath,
    }
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/data/normalize.test.ts`
Expected: 3 passed

- [ ] **Step 5: 写脚本 `scripts/sync-catalog.mjs`**

```js
// 从本机 opencli 生成 catalog 快照（list 主源 + 包内 manifest 补字段）。
// 用法：npm run sync-catalog
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stripBom, mergeManifestFields } from '../src/data/normalize.ts'

const manifestPath = join(
  homedir(),
  'AppData/Roaming/npm/node_modules/@jackwener/opencli/cli-manifest.json',
)
const opencliCmd = join(homedir(), 'AppData/Roaming/npm/opencli.cmd')

const listRaw = stripBom(execFileSync(opencliCmd, ['list', '-f', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
const list = JSON.parse(listRaw)
const manifestRaw = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(stripBom(manifestRaw))

const commands = mergeManifestFields(list, manifest)
const snapshot = {
  schemaVersion: 1,
  generatedAt: Date.now(),
  opencliVersion: JSON.parse(readFileSync(join(homedir(), 'AppData/Roaming/npm/node_modules/@jackwener/opencli/package.json'), 'utf8')).version,
  source: 'opencli list -f json',
  listSha256: createHash('sha256').update(listRaw).digest('hex'),
  manifestSha256: createHash('sha256').update(manifestRaw).digest('hex'),
  commands,
}

mkdirSync('public', { recursive: true })
writeFileSync('public/catalog.snapshot.json', JSON.stringify(snapshot))
console.log(`catalog: ${commands.length} commands, ${new Set(commands.map((c) => c.site)).size} sites`)
```

> 注：脚本 import `.ts` 依赖 Node 原生 TS 剥离（Node 23+ `--experimental-strip-types` 已默认可用；本机 Node 25 支持）。若报错，改用 `node --experimental-strip-types scripts/sync-catalog.mjs`，或把 `stripBom`/`mergeManifestFields` 内联进脚本。

- [ ] **Step 6: 运行脚本生成真实快照并核对**

Run: `npm run sync-catalog`
Expected: 打印 `catalog: 1278 commands, 175 sites`，生成 `public/catalog.snapshot.json`

- [ ] **Step 7: Commit**

```bash
git add src/data/normalize.ts src/data/normalize.test.ts scripts/sync-catalog.mjs public/catalog.snapshot.json
git commit -m "feat(data): list 归一化+manifest 补字段+sync-catalog 生成真实快照(1278/175)"
```

---

### Task 4: catalog 加载 / 搜索 / 站点分组

**Files:**
- Create: `src/data/catalog.ts`
- Test: `src/data/catalog.test.ts`

**Interfaces:**
- Consumes: `CommandManifest`、`CatalogSnapshot`（Task 2）。
- Produces: `loadCatalog(): Promise<CatalogSnapshot>`；`groupBySite(cmds): Array<{ site: string; commands: CommandManifest[] }>`；`searchCommands(cmds, q): CommandManifest[]`。

- [ ] **Step 1: 写失败测试 `src/data/catalog.test.ts`**

```ts
import { groupBySite, searchCommands } from './catalog'
import type { CommandManifest } from './types'

const c = (site: string, name: string, extra: Partial<CommandManifest> = {}): CommandManifest => ({
  command: `${site}/${name}`, site, name, description: '', access: 'read', browser: false, args: [], ...extra,
})

const cmds = [
  c('12306', 'login', { description: 'Open 12306 login' }),
  c('12306', 'orders'),
  c('xiaohongshu', 'download', { description: '下载笔记图片和视频', aliases: ['dl'] }),
]

test('groupBySite 按站点分组并按站点名排序', () => {
  const groups = groupBySite(cmds)
  expect(groups.map((g) => g.site)).toEqual(['12306', 'xiaohongshu'])
  expect(groups[0].commands).toHaveLength(2)
})

test('searchCommands 匹配 name/description/site/alias', () => {
  expect(searchCommands(cmds, 'download').map((x) => x.command)).toEqual(['xiaohongshu/download'])
  expect(searchCommands(cmds, '下载').map((x) => x.command)).toEqual(['xiaohongshu/download'])
  expect(searchCommands(cmds, 'dl').map((x) => x.command)).toEqual(['xiaohongshu/download'])
  expect(searchCommands(cmds, '12306').length).toBe(2)
})

test('searchCommands 空查询返回全部', () => {
  expect(searchCommands(cmds, '  ').length).toBe(3)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/data/catalog.test.ts`
Expected: FAIL

- [ ] **Step 3: 写实现 `src/data/catalog.ts`**

```ts
import type { CommandManifest, CatalogSnapshot } from './types'

export async function loadCatalog(): Promise<CatalogSnapshot> {
  const res = await fetch('/catalog.snapshot.json')
  if (!res.ok) throw new Error(`加载 catalog 失败：${res.status}`)
  return (await res.json()) as CatalogSnapshot
}

export function groupBySite(cmds: CommandManifest[]): Array<{ site: string; commands: CommandManifest[] }> {
  const map = new Map<string, CommandManifest[]>()
  for (const cmd of cmds) {
    const list = map.get(cmd.site) ?? []
    list.push(cmd)
    map.set(cmd.site, list)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([site, commands]) => ({ site, commands }))
}

export function searchCommands(cmds: CommandManifest[], q: string): CommandManifest[] {
  const query = q.trim().toLowerCase()
  if (!query) return cmds
  return cmds.filter((cmd) => {
    const hay = [
      cmd.site, cmd.name, cmd.description, cmd.domain ?? '',
      ...(cmd.aliases ?? []),
    ].join(' ').toLowerCase()
    return hay.includes(query)
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/data/catalog.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/data/catalog.ts src/data/catalog.test.ts
git commit -m "feat(data): catalog 加载/搜索/站点分组"
```

---

### Task 5: HostBridge 契约 + `deterministicMockHost`

**Files:**
- Create: `src/host/types.ts`
- Create: `src/host/mockHost.ts`
- Test: `src/host/mockHost.test.ts`

**Interfaces:**
- Produces: `RunRequest`、`OutputEvent`、`DoneEvent`、`RunOutcome`、`HostBridge`；`createMockHost(): HostBridge`。
- 约束：满足 Global Constraints 的 HostBridge 七条语义中与 host 相关的 ①②③④⑤（⑥⑦ 在 store 层）。

- [ ] **Step 1: 写 `src/host/types.ts`**

```ts
export type RunOutcome = 'success' | 'error' | 'cancelled'
export type OutputFormat = 'table' | 'plain' | 'json' | 'yaml' | 'md' | 'csv'

export type RunRequest = {
  runId: string
  site: string
  command: string
  args: Record<string, unknown>
  format?: OutputFormat
  mockScenario?: 'success' | 'error'   // 仅 mockHost 使用；缺省 success
}

export type OutputEvent = {
  runId: string
  seq: number
  at: number
  stream: 'stdout' | 'stderr'
  text: string
}

export type DoneEvent = {
  runId: string
  at: number
  outcome: RunOutcome
  exitCode?: number
  result?: Record<string, unknown>[]
  error?: { summary: string; detail?: string }
}

export interface HostBridge {
  startCommand(req: RunRequest): Promise<{ runId: string }>
  cancelCommand(runId: string): Promise<void>
  onOutput(cb: (e: OutputEvent) => void): () => void
  onDone(cb: (e: DoneEvent) => void): () => void
}
```

- [ ] **Step 2: 写失败测试 `src/host/mockHost.test.ts`**

```ts
import { createMockHost } from './mockHost'
import type { HostBridge, OutputEvent, DoneEvent } from './types'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function collect(host: HostBridge) {
  const outputs: OutputEvent[] = []
  const dones: DoneEvent[] = []
  host.onOutput((e) => outputs.push(e))
  host.onDone((e) => dones.push(e))
  return { outputs, dones }
}

test('成功：先有 output，最后恰好一个 success done', async () => {
  const host = createMockHost()
  const { outputs, dones } = collect(host)
  await host.startCommand({ runId: 'r1', site: 'x', command: 'c', args: {} })
  await vi.runAllTimersAsync()
  expect(dones).toHaveLength(1)
  expect(dones[0].outcome).toBe('success')
  expect(outputs.length).toBeGreaterThan(0)
  expect(outputs.every((o) => o.runId === 'r1')).toBe(true)
})

test('seq 严格单调递增且不重复', async () => {
  const host = createMockHost()
  const { outputs } = collect(host)
  await host.startCommand({ runId: 'r1', site: 'x', command: 'c', args: {} })
  await vi.runAllTimersAsync()
  const seqs = outputs.map((o) => o.seq)
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  expect(new Set(seqs).size).toBe(seqs.length)
})

test('cancel 幂等，产生唯一 cancelled done', async () => {
  const host = createMockHost()
  const { dones } = collect(host)
  await host.startCommand({ runId: 'r1', site: 'x', command: 'c', args: {} })
  await vi.advanceTimersByTimeAsync(35)
  await host.cancelCommand('r1')
  await host.cancelCommand('r1')
  await vi.runAllTimersAsync()
  expect(dones).toHaveLength(1)
  expect(dones[0].outcome).toBe('cancelled')
})

test('自然结束后迟到的 cancel 保留真实终态（竞态）', async () => {
  const host = createMockHost()
  const { dones } = collect(host)
  await host.startCommand({ runId: 'r1', site: 'x', command: 'c', args: {} })
  await vi.runAllTimersAsync()
  await host.cancelCommand('r1')
  expect(dones).toHaveLength(1)
  expect(dones[0].outcome).toBe('success')
})

test('error 场景：error done 带 exitCode 与摘要', async () => {
  const host = createMockHost()
  const { dones } = collect(host)
  await host.startCommand({ runId: 'r1', site: 'x', command: 'c', args: {}, mockScenario: 'error' })
  await vi.runAllTimersAsync()
  expect(dones[0].outcome).toBe('error')
  expect(dones[0].exitCode).toBe(1)
  expect(dones[0].error?.summary).toBeTruthy()
})

test('done 之后不再有该 run 的 output', async () => {
  const host = createMockHost()
  const { outputs } = collect(host)
  await host.startCommand({ runId: 'r1', site: 'x', command: 'c', args: {} })
  await vi.runAllTimersAsync()
  const atDone = outputs.length
  await vi.advanceTimersByTimeAsync(2000)
  expect(outputs.length).toBe(atDone)
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/host/mockHost.test.ts`
Expected: FAIL（`createMockHost` 未定义）

- [ ] **Step 4: 写实现 `src/host/mockHost.ts`**

```ts
import type { HostBridge, RunRequest, OutputEvent, DoneEvent, RunOutcome } from './types'

type ActiveRun = { seq: number; timers: ReturnType<typeof setTimeout>[]; done: boolean; cancelled: boolean }

export function createMockHost(): HostBridge {
  const outputCbs = new Set<(e: OutputEvent) => void>()
  const doneCbs = new Set<(e: DoneEvent) => void>()
  const runs = new Map<string, ActiveRun>()

  const emit = (runId: string, run: ActiveRun, stream: 'stdout' | 'stderr', text: string) => {
    if (run.done) return
    const e: OutputEvent = { runId, seq: run.seq++, at: Date.now(), stream, text }
    outputCbs.forEach((cb) => cb(e))
  }

  const finish = (runId: string, run: ActiveRun, outcome: RunOutcome, extra: Partial<DoneEvent> = {}) => {
    if (run.done) return                 // ① done-once
    run.done = true
    run.timers.forEach(clearTimeout)
    doneCbs.forEach((cb) => cb({ runId, at: Date.now(), outcome, ...extra }))
    runs.delete(runId)
  }

  return {
    async startCommand(req: RunRequest) {
      const run: ActiveRun = { seq: 0, timers: [], done: false, cancelled: false }
      runs.set(req.runId, run)
      run.timers.push(setTimeout(() => emit(req.runId, run, 'stdout', `启动 ${req.site} ${req.command}`), 10))
      run.timers.push(setTimeout(() => emit(req.runId, run, 'stdout', '正在连接…'), 30))
      if (req.mockScenario === 'error') {
        run.timers.push(setTimeout(() => emit(req.runId, run, 'stderr', '发生错误'), 50))
        run.timers.push(setTimeout(() => finish(req.runId, run, 'error', { exitCode: 1, error: { summary: '命令执行失败', detail: 'mock error detail' } }), 70))
      } else {
        run.timers.push(setTimeout(() => emit(req.runId, run, 'stdout', '完成'), 50))
        run.timers.push(setTimeout(() => finish(req.runId, run, 'success', { exitCode: 0, result: [{ status: 'ok', site: req.site }] }), 70))
      }
      return { runId: req.runId }
    },

    async cancelCommand(runId: string) {
      const run = runs.get(runId)
      if (!run || run.cancelled) return   // ②③ 幂等 + 已结束(natural)则 no-op 保留真实终态
      run.cancelled = true
      finish(runId, run, 'cancelled', { error: { summary: '已取消' } })
    },

    onOutput(cb) { outputCbs.add(cb); return () => { outputCbs.delete(cb) } },
    onDone(cb) { doneCbs.add(cb); return () => { doneCbs.delete(cb) } },
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/host/mockHost.test.ts`
Expected: 6 passed

- [ ] **Step 6: Commit**

```bash
git add src/host/types.ts src/host/mockHost.ts src/host/mockHost.test.ts
git commit -m "feat(host): 冻结 HostBridge 契约 + deterministicMockHost(契约测试 6 绿)"
```

---

### Task 6: `buildArgv` + `commandPreview`（单独转义）

**Files:**
- Create: `src/data/command.ts`
- Test: `src/data/command.test.ts`

**Interfaces:**
- Consumes: `CommandManifest`（Task 2）。
- Produces: `buildArgv(cmd, values): string[]`；`commandPreview(cmd, values): string`。
- 规则：布尔真才加 `--flag`（无值）；布尔假省略；值等于 default 仍显式传（P0 简单起见传非空值）；positional 按 args 顺序在 flag 前；`commandPreview` 对含空格/特殊字符的值加双引号，**仅供展示**。

- [ ] **Step 1: 写失败测试 `src/data/command.test.ts`**

```ts
import { buildArgv, commandPreview } from './command'
import type { CommandManifest } from './types'

const cmd = (args: CommandManifest['args']): CommandManifest => ({
  command: 'xiaohongshu/download', site: 'xiaohongshu', name: 'download',
  description: '', access: 'read', browser: true, args,
})

test('buildArgv：站点+命令在前，flag 带值', () => {
  const c = cmd([{ name: 'timeout', type: 'int' }])
  expect(buildArgv(c, { timeout: 300 })).toEqual(['xiaohongshu', 'download', '--timeout', '300'])
})

test('buildArgv：布尔 true 只加 flag，false 省略', () => {
  const c = cmd([{ name: 'images-only', type: 'boolean' }])
  expect(buildArgv(c, { 'images-only': true })).toEqual(['xiaohongshu', 'download', '--images-only'])
  expect(buildArgv(c, { 'images-only': false })).toEqual(['xiaohongshu', 'download'])
})

test('buildArgv：positional 按顺序在 flag 之前，无 -- 前缀', () => {
  const c = cmd([
    { name: 'url', type: 'str', positional: true },
    { name: 'timeout', type: 'int' },
  ])
  expect(buildArgv(c, { url: 'https://x', timeout: 5 })).toEqual(['xiaohongshu', 'download', 'https://x', '--timeout', '5'])
})

test('buildArgv：空/未填值跳过', () => {
  const c = cmd([{ name: 'out', type: 'str' }])
  expect(buildArgv(c, {})).toEqual(['xiaohongshu', 'download'])
  expect(buildArgv(c, { out: '' })).toEqual(['xiaohongshu', 'download'])
})

test('commandPreview：opencli 前缀 + 含空格的值加引号', () => {
  const c = cmd([{ name: 'out', type: 'str' }])
  expect(commandPreview(c, { out: 'my dir' })).toBe('opencli xiaohongshu download --out "my dir"')
  expect(commandPreview(c, { out: 'plain' })).toBe('opencli xiaohongshu download --out plain')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/data/command.test.ts`
Expected: FAIL

- [ ] **Step 3: 写实现 `src/data/command.ts`**

```ts
import type { CommandManifest, ManifestArg } from './types'

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === ''
}

export function buildArgv(cmd: CommandManifest, values: Record<string, unknown>): string[] {
  const argv: string[] = [cmd.site, cmd.name]
  const positional = cmd.args.filter((a) => a.positional)
  const flags = cmd.args.filter((a) => !a.positional)

  const pushValue = (a: ManifestArg) => {
    const v = values[a.name]
    if (a.type === 'bool' || a.type === 'boolean') {
      if (v === true) argv.push(`--${a.name}`)
      return
    }
    if (isEmpty(v)) return
    if (a.positional) argv.push(String(v))
    else argv.push(`--${a.name}`, String(v))
  }

  for (const a of positional) {
    if (a.type === 'bool' || a.type === 'boolean') continue
    if (!isEmpty(values[a.name])) argv.push(String(values[a.name]))
  }
  for (const a of flags) pushValue(a)
  return argv
}

function quote(s: string): string {
  return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

export function commandPreview(cmd: CommandManifest, values: Record<string, unknown>): string {
  const [site, name, ...rest] = buildArgv(cmd, values)
  const tail = rest.map((tok) => (tok.startsWith('--') ? tok : quote(tok))).join(' ')
  return `opencli ${site} ${name}${tail ? ' ' + tail : ''}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/data/command.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add src/data/command.ts src/data/command.test.ts
git commit -m "feat(data): buildArgv + commandPreview(展示层单独转义)"
```

---

### Task 7: 状态机 + Zustand store（四切片 + 脱敏）

**Files:**
- Create: `src/store/runMachine.ts`
- Test: `src/store/runMachine.test.ts`
- Create: `src/store/appStore.ts`
- Test: `src/store/appStore.test.ts`

**Interfaces:**
- Consumes: `CommandManifest`（Task 2）、`OutputEvent`/`DoneEvent`（Task 5）。
- Produces:
  - `RunState`、`RunEvent`、`transition(state, event): RunState`。
  - `CommandRun` 类型。
  - `redactValues(cmd, values): Record<string, unknown>`。
  - `useAppStore`（zustand）带：`commands/setCommands`、`selected/values/selectCommand/setValue`、`currentRun/beginRun/appendOutput/finishRun/markCancelling`、`mode`。

- [ ] **Step 1: 写失败测试 `src/store/runMachine.test.ts`**

```ts
import { transition } from './runMachine'

test('idle→validating→starting→running→succeeded', () => {
  expect(transition('idle', { type: 'RUN' })).toBe('validating')
  expect(transition('validating', { type: 'VALID' })).toBe('starting')
  expect(transition('starting', { type: 'OUTPUT' })).toBe('running')
  expect(transition('running', { type: 'DONE', outcome: 'success' })).toBe('succeeded')
})

test('校验失败回 idle', () => {
  expect(transition('validating', { type: 'INVALID' })).toBe('idle')
})

test('启动异常直接 failed', () => {
  expect(transition('starting', { type: 'DONE', outcome: 'error' })).toBe('failed')
})

test('取消：running→cancelling→cancelled', () => {
  expect(transition('running', { type: 'CANCEL' })).toBe('cancelling')
  expect(transition('cancelling', { type: 'DONE', outcome: 'cancelled' })).toBe('cancelled')
})

test('done 的 outcome 决定终态', () => {
  expect(transition('running', { type: 'DONE', outcome: 'error' })).toBe('failed')
  expect(transition('running', { type: 'DONE', outcome: 'cancelled' })).toBe('cancelled')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/store/runMachine.test.ts`
Expected: FAIL

- [ ] **Step 3: 写实现 `src/store/runMachine.ts`**

```ts
import type { RunOutcome } from '../host/types'

export type RunState =
  | 'idle' | 'validating' | 'starting' | 'running'
  | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'

export type RunEvent =
  | { type: 'RUN' }
  | { type: 'VALID' }
  | { type: 'INVALID' }
  | { type: 'OUTPUT' }
  | { type: 'CANCEL' }
  | { type: 'DONE'; outcome: RunOutcome }

const outcomeState: Record<RunOutcome, RunState> = {
  success: 'succeeded',
  error: 'failed',
  cancelled: 'cancelled',
}

export function transition(state: RunState, event: RunEvent): RunState {
  switch (state) {
    case 'idle':
      return event.type === 'RUN' ? 'validating' : state
    case 'validating':
      if (event.type === 'VALID') return 'starting'
      if (event.type === 'INVALID') return 'idle'
      return state
    case 'starting':
      if (event.type === 'OUTPUT') return 'running'
      if (event.type === 'DONE') return outcomeState[event.outcome]
      if (event.type === 'CANCEL') return 'cancelling'
      return state
    case 'running':
      if (event.type === 'CANCEL') return 'cancelling'
      if (event.type === 'DONE') return outcomeState[event.outcome]
      return state
    case 'cancelling':
      if (event.type === 'DONE') return outcomeState[event.outcome]
      return state
    default:
      return state
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/store/runMachine.test.ts`
Expected: 5 passed

- [ ] **Step 5: 写失败测试 `src/store/appStore.test.ts`**

```ts
import { redactValues, useAppStore } from './appStore'
import type { CommandManifest } from '../data/types'

const cmd: CommandManifest = {
  command: 'x/login', site: 'x', name: 'login', description: '', access: 'write', browser: true,
  args: [{ name: 'password', type: 'str' }, { name: 'timeout', type: 'int' }],
}

test('redactValues 脱敏敏感字段', () => {
  const out = redactValues(cmd, { password: 'secret', timeout: 5 })
  expect(out.password).toBe('••••')
  expect(out.timeout).toBe(5)
})

test('selectCommand 重置 values 为默认值', () => {
  const withDefault: CommandManifest = { ...cmd, args: [{ name: 'timeout', type: 'int', default: 300 }] }
  useAppStore.getState().selectCommand(withDefault)
  expect(useAppStore.getState().values).toEqual({ timeout: 300 })
})

test('beginRun→appendOutput→finishRun 驱动状态与日志', () => {
  useAppStore.getState().selectCommand(cmd)
  useAppStore.getState().beginRun('run-1')
  expect(useAppStore.getState().currentRun?.state).toBe('starting')
  useAppStore.getState().appendOutput({ runId: 'run-1', seq: 0, at: 1, stream: 'stdout', text: 'hi' })
  expect(useAppStore.getState().currentRun?.state).toBe('running')
  expect(useAppStore.getState().currentRun?.lines).toHaveLength(1)
  useAppStore.getState().finishRun({ runId: 'run-1', at: 2, outcome: 'success', result: [{ ok: 1 }] })
  expect(useAppStore.getState().currentRun?.state).toBe('succeeded')
  expect(useAppStore.getState().currentRun?.result).toEqual([{ ok: 1 }])
})

test('mode 默认 demo', () => {
  expect(useAppStore.getState().mode).toBe('demo')
})
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npx vitest run src/store/appStore.test.ts`
Expected: FAIL（`appStore` 未定义）

- [ ] **Step 7: 写实现 `src/store/appStore.ts`**

```ts
import { create } from 'zustand'
import type { CommandManifest } from '../data/types'
import type { OutputEvent, DoneEvent } from '../host/types'
import { transition, type RunState } from './runMachine'

const SENSITIVE = /pass|token|secret|cookie|key/i

export function redactValues(cmd: CommandManifest, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) out[k] = SENSITIVE.test(k) && !!v ? '••••' : v
  return out
}

export type CommandRun = {
  id: string
  command: CommandManifest
  values: Record<string, unknown>          // 已脱敏
  state: RunState
  startedAt: number
  endedAt?: number
  lines: OutputEvent[]
  result?: Record<string, unknown>[]
  error?: { summary: string; detail?: string }
}

function defaultsOf(cmd: CommandManifest): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const a of cmd.args) if (a.default !== undefined) v[a.name] = a.default
  return v
}

type AppState = {
  commands: CommandManifest[]
  setCommands: (cmds: CommandManifest[]) => void
  selected?: CommandManifest
  values: Record<string, unknown>
  selectCommand: (cmd: CommandManifest) => void
  setValue: (name: string, value: unknown) => void
  currentRun?: CommandRun
  beginRun: (runId: string) => void
  appendOutput: (e: OutputEvent) => void
  finishRun: (e: DoneEvent) => void
  markCancelling: () => void
  mode: 'demo' | 'connected'
}

export const useAppStore = create<AppState>((set, get) => ({
  commands: [],
  setCommands: (commands) => set({ commands }),
  selected: undefined,
  values: {},
  selectCommand: (cmd) => set({ selected: cmd, values: defaultsOf(cmd) }),
  setValue: (name, value) => set((s) => ({ values: { ...s.values, [name]: value } })),
  currentRun: undefined,
  beginRun: (runId) => {
    const cmd = get().selected
    if (!cmd) return
    set({
      currentRun: {
        id: runId, command: cmd, values: redactValues(cmd, get().values),
        state: transition(transition('idle', { type: 'RUN' }), { type: 'VALID' }), // →starting
        startedAt: Date.now(), lines: [],
      },
    })
  },
  appendOutput: (e) => set((s) => {
    if (!s.currentRun || s.currentRun.id !== e.runId) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'OUTPUT' }), lines: [...s.currentRun.lines, e] } }
  }),
  finishRun: (e) => set((s) => {
    if (!s.currentRun || s.currentRun.id !== e.runId) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'DONE', outcome: e.outcome }), endedAt: e.at, result: e.result, error: e.error } }
  }),
  markCancelling: () => set((s) => {
    if (!s.currentRun) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'CANCEL' }) } }
  }),
  mode: 'demo',
}))
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run src/store/appStore.test.ts src/store/runMachine.test.ts`
Expected: 全部 passed

- [ ] **Step 9: Commit**

```bash
git add src/store/
git commit -m "feat(store): 运行状态机 + zustand 四切片 + 敏感参数脱敏"
```

---

### Task 8: 三栏骨架 AppShell + HealthPill

**Files:**
- Create: `src/components/AppShell.tsx`
- Create: `src/components/HealthPill.tsx`
- Modify: `src/App.tsx`
- Test: `src/components/AppShell.test.tsx`

**Interfaces:**
- Consumes: `useAppStore`（Task 7）。
- Produces: `AppShell`（默认导出的三栏布局，接收 `nav`/`config`/`runs` 三个 ReactNode 插槽）；`HealthPill`。

- [ ] **Step 1: 写 `src/components/HealthPill.tsx`**

```tsx
import { useAppStore } from '../store/appStore'

export function HealthPill() {
  const mode = useAppStore((s) => s.mode)
  const demo = mode === 'demo'
  return (
    <span
      data-testid="health-pill"
      className="inline-flex items-center gap-2 rounded-lg px-3 py-1 text-sm"
      style={{ background: 'var(--color-panel)', color: demo ? 'var(--color-warning)' : 'var(--color-success)' }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 8, background: 'currentColor' }} />
      {demo ? '演示模式' : '已连接'}
    </span>
  )
}
```

- [ ] **Step 2: 写 `src/components/AppShell.tsx`**

```tsx
import type { ReactNode } from 'react'
import { HealthPill } from './HealthPill'

export default function AppShell({ nav, config, runs }: { nav: ReactNode; config: ReactNode; runs: ReactNode }) {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: 'var(--color-line)' }}>
        <div className="font-semibold">OpenCLI App</div>
        <HealthPill />
      </header>
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: '280px minmax(520px, 1fr) 360px' }}>
        <aside data-testid="col-nav" className="min-h-0 overflow-auto border-r" style={{ borderColor: 'var(--color-line)', background: 'var(--color-panel)' }}>{nav}</aside>
        <main data-testid="col-config" className="min-h-0 overflow-auto p-4">{config}</main>
        <section data-testid="col-runs" className="min-h-0 overflow-auto border-l" style={{ borderColor: 'var(--color-line)', background: 'var(--color-panel)' }}>{runs}</section>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 改 `src/App.tsx` 挂上三栏（插槽先放占位）**

```tsx
import AppShell from './components/AppShell'

export default function App() {
  return (
    <div data-testid="app-root" className="h-full">
      <AppShell
        nav={<div className="p-3 text-sm" style={{ color: 'var(--color-fg-dim)' }}>导航</div>}
        config={<div className="text-sm" style={{ color: 'var(--color-fg-dim)' }}>从左侧选择一个服务和命令</div>}
        runs={<div className="p-3 text-sm" style={{ color: 'var(--color-fg-dim)' }}>暂无任务</div>}
      />
    </div>
  )
}
```

- [ ] **Step 4: 写测试 `src/components/AppShell.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react'
import App from '../App'

test('三栏 + 顶部健康 pill 显示演示模式', () => {
  render(<App />)
  expect(screen.getByTestId('col-nav')).toBeInTheDocument()
  expect(screen.getByTestId('col-config')).toBeInTheDocument()
  expect(screen.getByTestId('col-runs')).toBeInTheDocument()
  expect(screen.getByTestId('health-pill')).toHaveTextContent('演示模式')
})
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/AppShell.test.tsx`
Expected: 1 passed

- [ ] **Step 6: Commit**

```bash
git add src/components/ src/App.tsx
git commit -m "feat(ui): 三栏骨架 AppShell + 演示模式健康 pill"
```

---

### Task 9: 左栏 SiteCommandNav（搜索 + 站点分组 + 选命令）

**Files:**
- Create: `src/features/nav/SiteCommandNav.tsx`
- Test: `src/features/nav/SiteCommandNav.test.tsx`

**Interfaces:**
- Consumes: `useAppStore`（`commands`/`selected`/`selectCommand`），`searchCommands`/`groupBySite`（Task 4）。
- Produces: `SiteCommandNav`（无 props，读 store）。

- [ ] **Step 1: 写 `src/features/nav/SiteCommandNav.tsx`**

```tsx
import { useMemo, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { searchCommands, groupBySite } from '../../data/catalog'

export function SiteCommandNav() {
  const commands = useAppStore((s) => s.commands)
  const selected = useAppStore((s) => s.selected)
  const selectCommand = useAppStore((s) => s.selectCommand)
  const [q, setQ] = useState('')

  const groups = useMemo(() => groupBySite(searchCommands(commands, q)), [commands, q])

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <input
          data-testid="nav-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索服务或命令"
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
        />
      </div>
      <nav className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {groups.map((g) => (
          <div key={g.site} className="mb-3">
            <div className="px-2 py-1 text-xs uppercase tracking-wide" style={{ color: 'var(--color-fg-dim)' }}>{g.site}</div>
            {g.commands.map((cmd) => {
              const active = selected?.command === cmd.command
              return (
                <button
                  key={cmd.command}
                  onClick={() => selectCommand(cmd)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm"
                  style={{ background: active ? 'var(--color-hover)' : 'transparent', color: 'var(--color-fg)' }}
                >
                  <span>{cmd.name}</span>
                  <span className="text-xs" style={{ color: cmd.access === 'write' ? 'var(--color-warning)' : 'var(--color-fg-dim)' }}>{cmd.access}</span>
                </button>
              )
            })}
          </div>
        ))}
        {groups.length === 0 && <div className="px-3 py-2 text-sm" style={{ color: 'var(--color-fg-dim)' }}>无匹配命令</div>}
      </nav>
    </div>
  )
}
```

- [ ] **Step 2: 写测试 `src/features/nav/SiteCommandNav.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SiteCommandNav } from './SiteCommandNav'
import { useAppStore } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'

const c = (site: string, name: string): CommandManifest => ({
  command: `${site}/${name}`, site, name, description: '', access: 'read', browser: false, args: [],
})

beforeEach(() => {
  useAppStore.setState({ commands: [c('12306', 'login'), c('12306', 'orders'), c('xiaohongshu', 'download')], selected: undefined, values: {} })
})

test('渲染站点分组与命令', () => {
  render(<SiteCommandNav />)
  expect(screen.getByText('12306')).toBeInTheDocument()
  expect(screen.getByText('download')).toBeInTheDocument()
})

test('搜索过滤命令', async () => {
  render(<SiteCommandNav />)
  await userEvent.type(screen.getByTestId('nav-search'), 'download')
  expect(screen.getByText('download')).toBeInTheDocument()
  expect(screen.queryByText('orders')).not.toBeInTheDocument()
})

test('点击命令写入 selected', async () => {
  render(<SiteCommandNav />)
  await userEvent.click(screen.getByText('login'))
  expect(useAppStore.getState().selected?.command).toBe('12306/login')
})
```

- [ ] **Step 3: 跑测试确认通过**

Run: `npx vitest run src/features/nav/SiteCommandNav.test.tsx`
Expected: 3 passed

- [ ] **Step 4: Commit**

```bash
git add src/features/nav/
git commit -m "feat(nav): 左栏搜索+站点分组+选命令"
```

---

### Task 10: 中栏 CommandConfig（命令头 + 动态表单 + 校验 + 预览）

**Files:**
- Create: `src/features/config/validation.ts`
- Test: `src/features/config/validation.test.ts`
- Create: `src/features/config/DynamicField.tsx`
- Create: `src/features/config/CommandConfig.tsx`
- Test: `src/features/config/CommandConfig.test.tsx`

**Interfaces:**
- Consumes: `useAppStore`（`selected`/`values`/`setValue`），`inputKind`（Task 2），`commandPreview`（Task 6）。
- Produces: `validate(cmd, values): Record<string, string>`（字段名→错误）；`DynamicField`；`CommandConfig`（props: `onRun(): void`）。

- [ ] **Step 1: 写失败测试 `src/features/config/validation.test.ts`**

```ts
import { validate } from './validation'
import type { CommandManifest } from '../../data/types'

const cmd: CommandManifest = {
  command: 'x/go', site: 'x', name: 'go', description: '', access: 'read', browser: false,
  args: [
    { name: 'url', type: 'str', required: true },
    { name: 'count', type: 'int' },
  ],
}

test('必填缺失报错', () => {
  expect(validate(cmd, {})).toEqual({ url: '此字段必填' })
})
test('数字字段非数值报错', () => {
  expect(validate(cmd, { url: 'x', count: 'abc' })).toEqual({ count: '请输入数字' })
})
test('合法输入无错误', () => {
  expect(validate(cmd, { url: 'x', count: 5 })).toEqual({})
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/features/config/validation.test.ts`
Expected: FAIL

- [ ] **Step 3: 写实现 `src/features/config/validation.ts`**

```ts
import type { CommandManifest } from '../../data/types'

export function validate(cmd: CommandManifest, values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const a of cmd.args) {
    const v = values[a.name]
    const empty = v === undefined || v === null || v === ''
    if (a.required && empty) { errors[a.name] = '此字段必填'; continue }
    if (!empty && (a.type === 'int' || a.type === 'number' || a.type === 'float') && Number.isNaN(Number(v))) {
      errors[a.name] = '请输入数字'
    }
  }
  return errors
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/features/config/validation.test.ts`
Expected: 3 passed

- [ ] **Step 5: 写 `src/features/config/DynamicField.tsx`**

```tsx
import type { ManifestArg } from '../../data/types'
import { inputKind } from '../../data/inputKind'

export function DynamicField({ arg, value, error, onChange }: {
  arg: ManifestArg; value: unknown; error?: string; onChange: (v: unknown) => void
}) {
  const kind = inputKind(arg)
  const base = 'w-full rounded-lg px-3 py-2 text-sm outline-none'
  const style = { background: 'var(--color-canvas)', border: `1px solid ${error ? 'var(--color-danger)' : 'var(--color-line)'}`, color: 'var(--color-fg)' }
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-sm">{arg.name}{arg.required && <span style={{ color: 'var(--color-danger)' }}> *</span>}</span>
      {kind === 'switch' ? (
        <input data-testid={`field-${arg.name}`} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      ) : kind === 'select' ? (
        <select data-testid={`field-${arg.name}`} className={base} style={style} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="" />
          {(arg.choices ?? []).map((ch) => {
            const val = typeof ch === 'string' ? ch : ch.value
            const label = typeof ch === 'string' ? ch : ch.label
            return <option key={val} value={val}>{label}</option>
          })}
        </select>
      ) : (
        <input data-testid={`field-${arg.name}`} className={base} style={style}
          type={kind === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
          onChange={(e) => onChange(kind === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
      )}
      {arg.help && <span className="mt-1 block text-xs" style={{ color: 'var(--color-fg-dim)' }}>{arg.help}</span>}
      {error && <span data-testid={`error-${arg.name}`} className="mt-1 block text-xs" style={{ color: 'var(--color-danger)' }}>{error}</span>}
    </label>
  )
}
```

- [ ] **Step 6: 写 `src/features/config/CommandConfig.tsx`**

```tsx
import { useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { commandPreview } from '../../data/command'
import { validate } from './validation'
import { DynamicField } from './DynamicField'

export function CommandConfig({ onRun }: { onRun: () => void }) {
  const selected = useAppStore((s) => s.selected)
  const values = useAppStore((s) => s.values)
  const setValue = useAppStore((s) => s.setValue)
  const currentRun = useAppStore((s) => s.currentRun)
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!selected) return <div className="text-sm" style={{ color: 'var(--color-fg-dim)' }}>从左侧选择一个服务和命令</div>

  const running = currentRun?.state === 'starting' || currentRun?.state === 'running' || currentRun?.state === 'cancelling'

  const handleRun = () => {
    const errs = validate(selected, values)
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      const first = selected.args.find((a) => errs[a.name])
      if (first) document.querySelector<HTMLElement>(`[data-testid="field-${first.name}"]`)?.focus()
      return
    }
    onRun()
  }

  return (
    <div>
      <div className="mb-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>{selected.site} / {selected.name}</div>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-lg font-semibold">{selected.name}</h2>
        <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--color-hover)', color: selected.access === 'write' ? 'var(--color-warning)' : 'var(--color-fg-dim)' }}>{selected.access}</span>
        {selected.browser && <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--color-hover)', color: 'var(--color-fg-dim)' }}>浏览器</span>}
      </div>
      <p className="mb-4 text-sm" style={{ color: 'var(--color-fg-dim)' }}>{selected.description}</p>

      <div className="mb-4">
        {selected.args.map((arg) => (
          <DynamicField key={arg.name} arg={arg} value={values[arg.name]} error={errors[arg.name]}
            onChange={(v) => { setValue(arg.name, v); setErrors((e) => { const { [arg.name]: _drop, ...rest } = e; return rest }) }} />
        ))}
        {selected.args.length === 0 && <div className="text-sm" style={{ color: 'var(--color-fg-dim)' }}>此命令无参数</div>}
      </div>

      <pre className="mb-4 overflow-x-auto rounded-lg p-3 text-xs" style={{ background: 'var(--color-canvas)', color: 'var(--color-fg-dim)' }}>{commandPreview(selected, values)}</pre>

      <button data-testid="run-button" disabled={running} onClick={handleRun}
        className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
        style={{ background: 'var(--color-accent)', color: '#fff' }}>
        {running ? '运行中…' : '运行任务'}
      </button>
    </div>
  )
}
```

- [ ] **Step 7: 写测试 `src/features/config/CommandConfig.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandConfig } from './CommandConfig'
import { useAppStore } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'

const cmd: CommandManifest = {
  command: 'x/go', site: 'x', name: 'go', description: '示例', access: 'read', browser: false,
  args: [{ name: 'url', type: 'str', required: true }],
}

beforeEach(() => useAppStore.setState({ selected: cmd, values: {}, currentRun: undefined }))

test('无选中命令时提示', () => {
  useAppStore.setState({ selected: undefined })
  render(<CommandConfig onRun={() => {}} />)
  expect(screen.getByText('从左侧选择一个服务和命令')).toBeInTheDocument()
})

test('必填缺失时点运行不触发 onRun 并显示错误', async () => {
  const onRun = vi.fn()
  render(<CommandConfig onRun={onRun} />)
  await userEvent.click(screen.getByTestId('run-button'))
  expect(onRun).not.toHaveBeenCalled()
  expect(screen.getByTestId('error-url')).toHaveTextContent('此字段必填')
})

test('填写后点运行触发 onRun', async () => {
  const onRun = vi.fn()
  render(<CommandConfig onRun={onRun} />)
  await userEvent.type(screen.getByTestId('field-url'), 'https://x')
  await userEvent.click(screen.getByTestId('run-button'))
  expect(onRun).toHaveBeenCalledOnce()
})

test('命令预览随输入更新', async () => {
  render(<CommandConfig onRun={() => {}} />)
  await userEvent.type(screen.getByTestId('field-url'), 'abc')
  expect(screen.getByText('opencli x go --url abc')).toBeInTheDocument()
})
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run src/features/config/`
Expected: 全部 passed

- [ ] **Step 9: Commit**

```bash
git add src/features/config/
git commit -m "feat(config): 命令头+动态表单+点运行才校验+聚焦缺失+命令预览"
```

---

### Task 11: 右栏 RunPanel + 端到端接线（mockHost → store）

**Files:**
- Create: `src/features/runs/StreamLog.tsx`
- Create: `src/features/runs/ResultsTable.tsx`
- Create: `src/features/runs/RunPanel.tsx`
- Modify: `src/App.tsx`
- Test: `src/features/runs/RunPanel.test.tsx`

**Interfaces:**
- Consumes: `useAppStore`（Task 7）、`createMockHost`（Task 5）、`CommandConfig`（Task 10）、`SiteCommandNav`（Task 9）。P0-A 的 mockHost 直接消费 `args` 对象，argv 仅用于 Task 10 的预览显示，故此处不依赖 `buildArgv`。
- Produces: `RunPanel`（props: `host: HostBridge; onCancel(): void`）；`App` 完成 nav/config/runs 接线，`onRun` 用 host 启动、订阅 output/done 回写 store。

- [ ] **Step 1: 写 `src/features/runs/StreamLog.tsx`**

```tsx
import type { OutputEvent } from '../../host/types'

export function StreamLog({ lines }: { lines: OutputEvent[] }) {
  return (
    <div data-testid="stream-log" className="max-h-64 overflow-auto rounded-lg p-2 font-mono text-xs" style={{ background: 'var(--color-canvas)' }}>
      {lines.map((l) => (
        <div key={l.seq} style={{ color: l.stream === 'stderr' ? 'var(--color-danger)' : 'var(--color-fg)' }}>{l.text}</div>
      ))}
      {lines.length === 0 && <div style={{ color: 'var(--color-fg-dim)' }}>暂无输出</div>}
    </div>
  )
}
```

- [ ] **Step 2: 写 `src/features/runs/ResultsTable.tsx`**

```tsx
export function ResultsTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  return (
    <table data-testid="results-table" className="w-full text-left text-xs">
      <thead><tr>{columns.map((c) => <th key={c} className="border-b px-2 py-1" style={{ borderColor: 'var(--color-line)', color: 'var(--color-fg-dim)' }}>{c}</th>)}</tr></thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>{columns.map((c) => <td key={c} className="px-2 py-1">{String(row[c] ?? '')}</td>)}</tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 3: 写 `src/features/runs/RunPanel.tsx`**

```tsx
import { useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { StreamLog } from './StreamLog'
import { ResultsTable } from './ResultsTable'

export function RunPanel({ onCancel }: { onCancel: () => void }) {
  const run = useAppStore((s) => s.currentRun)
  const [tab, setTab] = useState<'result' | 'log'>('log')
  if (!run) return <div className="p-3 text-sm" style={{ color: 'var(--color-fg-dim)' }}>暂无任务</div>

  const active = run.state === 'starting' || run.state === 'running' || run.state === 'cancelling'
  const columns = run.command.columns ?? []
  const showTable = run.state === 'succeeded' && columns.length > 0 && (run.result?.length ?? 0) > 0

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex items-center justify-between">
        <span data-testid="run-state" className="text-sm font-medium">{stateLabel(run.state)}</span>
        {active && (
          <button data-testid="cancel-button" onClick={onCancel} disabled={run.state === 'cancelling'}
            className="rounded-lg px-3 py-1 text-sm disabled:opacity-50" style={{ background: 'var(--color-danger)', color: '#fff' }}>
            {run.state === 'cancelling' ? '正在取消…' : '取消执行'}
          </button>
        )}
      </div>

      {run.error && <div className="mb-2 rounded-lg p-2 text-sm" style={{ background: 'var(--color-canvas)', color: 'var(--color-danger)' }}>{run.error.summary}</div>}

      {showTable && (
        <div className="mb-2 flex gap-2 text-xs">
          <button onClick={() => setTab('result')} style={{ color: tab === 'result' ? 'var(--color-accent)' : 'var(--color-fg-dim)' }}>表格结果</button>
          <button onClick={() => setTab('log')} style={{ color: tab === 'log' ? 'var(--color-accent)' : 'var(--color-fg-dim)' }}>完整日志</button>
        </div>
      )}

      {showTable && tab === 'result'
        ? <ResultsTable columns={columns} rows={run.result ?? []} />
        : <StreamLog lines={run.lines} />}
    </div>
  )
}

function stateLabel(s: string): string {
  return ({ starting: '正在启动…', running: '运行中…', cancelling: '正在取消…', succeeded: '已完成', failed: '失败', cancelled: '已取消' } as Record<string, string>)[s] ?? s
}
```

- [ ] **Step 4: 改 `src/App.tsx` 完成端到端接线**

```tsx
import { useEffect, useMemo } from 'react'
import AppShell from './components/AppShell'
import { SiteCommandNav } from './features/nav/SiteCommandNav'
import { CommandConfig } from './features/config/CommandConfig'
import { RunPanel } from './features/runs/RunPanel'
import { useAppStore } from './store/appStore'
import { loadCatalog } from './data/catalog'
import { createMockHost } from './host/mockHost'

let runSeq = 0

export default function App() {
  const host = useMemo(() => createMockHost(), [])
  const setCommands = useAppStore((s) => s.setCommands)

  useEffect(() => {
    const offOut = host.onOutput((e) => useAppStore.getState().appendOutput(e))
    const offDone = host.onDone((e) => useAppStore.getState().finishRun(e))
    loadCatalog().then((snap) => setCommands(snap.commands)).catch(() => {})
    return () => { offOut(); offDone() }
  }, [host, setCommands])

  const onRun = () => {
    const s = useAppStore.getState()
    if (!s.selected) return
    const runId = `run-${++runSeq}`
    s.beginRun(runId)
    void host.startCommand({ runId, site: s.selected.site, command: s.selected.name, args: s.values })
  }

  const onCancel = () => {
    const run = useAppStore.getState().currentRun
    if (!run) return
    useAppStore.getState().markCancelling()   // ⑥ 立即进入 cancelling，×不改状态
    void host.cancelCommand(run.id)
  }

  return (
    <div data-testid="app-root" className="h-full">
      <AppShell nav={<SiteCommandNav />} config={<CommandConfig onRun={onRun} />} runs={<RunPanel onCancel={onCancel} />} />
    </div>
  )
}
```

- [ ] **Step 5: 写集成测试 `src/features/runs/RunPanel.test.tsx`**

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../../App'
import { useAppStore } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'

const cmd: CommandManifest = {
  command: 'x/go', site: 'x', name: 'go', description: '', access: 'read', browser: false, args: [], columns: ['status', 'site'],
}

beforeEach(() => {
  useAppStore.setState({ commands: [cmd], selected: cmd, values: {}, currentRun: undefined })
})

test('端到端：运行一条 mock 命令走到成功终态并出表格', async () => {
  render(<App />)
  await userEvent.click(screen.getByTestId('run-button'))
  await waitFor(() => expect(screen.getByTestId('run-state')).toHaveTextContent('已完成'), { timeout: 2000 })
  await userEvent.click(screen.getByText('表格结果'))
  expect(screen.getByTestId('results-table')).toBeInTheDocument()
})

test('运行中显示取消执行按钮', async () => {
  render(<App />)
  await userEvent.click(screen.getByTestId('run-button'))
  await waitFor(() => expect(screen.getByTestId('cancel-button')).toBeInTheDocument())
})
```

- [ ] **Step 6: 跑全量测试**

Run: `npm test`
Expected: 全部 passed（App/inputKind/normalize/catalog/mockHost/command/runMachine/appStore/AppShell/SiteCommandNav/validation/CommandConfig/RunPanel）

- [ ] **Step 7: 浏览器冒烟（真实 catalog）**

Run: `npm run dev`，用浏览器预览打开 dev 地址。
Expected: 左栏出现 175 站点 / 1278 命令；选一条命令→填参→点运行→右栏流式输出→到"已完成"；再选一条点运行后点"取消执行"→"已取消"。

- [ ] **Step 8: Commit**

```bash
git add src/features/runs/ src/App.tsx
git commit -m "feat(runs): 右栏任务卡+流式日志+结果表+取消，端到端 mock 闭环打通"
```

---

## P0-A 验收对照

| spec §12 验收项 | 对应 Task |
|---|---|
| 工程基线可 dev/build/test | Task 1 |
| sync-catalog 带 version/time/sha256 + manifest 补字段 | Task 3 |
| 左栏 175/1278 导航 + 搜索 + 分组 | Task 4 + 9 |
| 动态表单 7 类字段 + 点运行才校验 + 聚焦缺失 | Task 2 + 10 |
| argv 构建 + 只读预览（单独转义） | Task 6 + 10 |
| mockHost 满足 §5 契约 | Task 5 |
| 三终态闭环 + runId 贯穿 + 恒显取消 + ×只收起 | Task 7 + 11 |
| 三栏骨架 + 8 态状态机可视 | Task 8 + 11 |
| 顶部健康态"演示模式" | Task 8 |
| 单测 + 契约测试全绿 | 各 Task + Task 11 Step 6 |

## 下一阶段（不在本计划）

- **P0-B**：`server/` 轻量 Node Host（`spawn(bin, argv, {shell:false})` + SSE），先跑一条 PUBLIC 只读命令，再一条 BrowserBridge 命令；`host/index.ts` 按环境切换 mock/node。
- **P0-C**：两级收藏 + 持久化、最近使用、`columns` 视图增强、重跑/复制、catalog 刷新、错误重试。
- **P1**：Tauri hello-world + SxS 14001 专项验证 → `tauriHost`。
