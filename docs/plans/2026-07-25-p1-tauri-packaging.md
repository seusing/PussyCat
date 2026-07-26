# P1 Tauri 打包 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P0 工作台打包成可安装的 Windows 桌面应用（Tauri 壳 + 受管 Node Host 子进程 + 内置 OpenCLI runtime），进程树可回收、随机端口单一事实源、闭包可复现。

**Architecture:** Tauri 主进程用 Job Object + stdin EOF 双通道托管 `node dist-host/server/index.mjs`（`OPENCLI_HOST_PORT=0`），读 readiness JSON 拿随机端口后建窗并注入 boot 配置；前端沿用 `nodeBridgeHost`，`baseUrl` 由 boot 注入并经 props 贯穿到 HealthPill。冻结的执行契约（policy 白名单 / commandKey==argv / 强制 `-f json` / SSE 形状）一字不动。

**Tech Stack:** 现有 Vite+React+TS+Zustand+Vitest；新增 Tauri v2（Rust 1.97.1 已就绪）、`windows` crate（Job Object）、`tauri-plugin-single-instance`。

**Spec:** `docs/specs/2026-07-25-p1-tauri-packaging-design.md`（v3，含两轮设计复审回执）。

## Global Constraints（每 task 隐含）

- **冻结执行契约零触碰**：`/start /cancel /events` 语义与 SSE 事件形状、`HostBridge` 接口、policy 过滤准则（read+public+browser=false）、`commandKey===argv[0]/[1]`、强制 `-f json`、回环 bind —— 全部不动。
- **Node 门槛 `>=20`**（与 opencli `engines` 持平）；引导文案**推荐当前 LTS 22/24**，只把 20 写成"最低可运行"（Node 20 已 EOL）。
- **`dist-host/` 必须镜像仓内相对拓扑**（`dist-host/src/shared/` + `dist-host/server/`）——server 用相对 import，拍平必断。
- **闭包硬闸**：T4 不过，T5+ 一律不开工。
- **进程清理双通道**：Job Object（覆盖崩溃）+ stdin EOF 看门狗（覆盖 Job 分配失败）；两者皆不可用 → fail-closed。
- 提交门：每 task `npx tsc --noEmit && npm test && npm run build` 全链 `&&` 通过才 commit（Rust task 另加 `cargo build`）；只 `git add` 各 task 点名文件。
- 仓内文件先读再改，最小 diff；既有断言不得删除或弱化（改语义时**改写**断言）。

---

### Task 1: 消除运行时 `.ts` import + Node 门槛降到 20

**Files:**
- Create: `src/shared/normalize.mjs`、`src/shared/normalize.d.mts`、`src/shared/catalogSchema.mjs`、`src/shared/catalogSchema.d.mts`
- Delete: `src/data/normalize.ts`、`src/data/catalogSchema.ts`
- Modify: `src/data/catalog.ts`、`server/catalog-service.mjs`、`scripts/sync-catalog.mjs`、`server/index.mjs`、`package.json`(engines)
- Test: 移动 `src/data/catalogSchema.test.ts` → `src/shared/catalogSchema.test.ts`（import 路径改），其余测试按 grep 结果跟改

**Interfaces:** Produces `src/shared/*.mjs` 的同名导出（`stripBom`/`mergeManifestFields`/`assertCatalogCommands`/`CatalogSchemaError`），签名与原 `.ts` **逐字相同**。

- [ ] **Step 1: 先 grep 全仓消费点**（避免漏改，本仓栽过"消费点须 grep 全仓"的跟头）

Run:
```bash
cd "C:/Users/Lauseusing/Developer/opencli-app-clone" && grep -rn "data/normalize\|data/catalogSchema\|from './normalize'\|from './catalogSchema'" src server scripts
```
把命中清单记进报告；下面每个文件都要改到。

- [ ] **Step 2: 迁移模块（内容逐字搬，只删类型注解、补 `.d.mts`）**

`src/shared/normalize.mjs`：把 `src/data/normalize.ts` 的实现原样搬过来，**删掉** `import type { CommandManifest }` 与参数/返回类型注解（其余逻辑一字不改）。
`src/shared/normalize.d.mts`：
```ts
import type { CommandManifest } from '../data/types'

export type RawManifestCmd = {
  site: string
  name: string
  navigateBefore?: boolean | string
  defaultWindowMode?: string
  type?: string
  modulePath?: string
}

export function stripBom(s: string): string
export function mergeManifestFields(list: CommandManifest[], manifest: RawManifestCmd[]): CommandManifest[]
```

`src/shared/catalogSchema.mjs`：同法搬 `src/data/catalogSchema.ts`（删类型注解与 `asserts` 签名；`CatalogSchemaError` 类原样）。
`src/shared/catalogSchema.d.mts`：
```ts
import type { CommandManifest } from '../data/types'

export class CatalogSchemaError extends Error {}
export function assertCatalogCommands(commands: unknown): asserts commands is CommandManifest[]
```

- [ ] **Step 3: 改全部消费点**

- `src/data/catalog.ts`：`import { assertCatalogCommands } from './catalogSchema'` → `from '../shared/catalogSchema.mjs'`
- `server/catalog-service.mjs`：两行 import 改 `'../src/shared/normalize.mjs'` / `'../src/shared/catalogSchema.mjs'`
- `scripts/sync-catalog.mjs`：改 `'../src/shared/normalize.mjs'`
- 测试文件：`catalogSchema.test.ts` 移到 `src/shared/`，import 改 `'./catalogSchema.mjs'`；真实快照断言路径不变
- `package.json`：`"engines": { "node": ">=20" }`

- [ ] **Step 4: 拆掉 Node>=23 guard，改 20（`server/index.mjs`）**

把文件顶部「先断言 `nodeMajor < 23` 再 `await import(...)`」整块替换为**静态 import + `>=20` 断言**（无 `.ts` 依赖后不再有"断言前解析依赖图"的陷阱）：
```js
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHostServer } from './host-server.mjs'
import { resolveOpenCliEntry, resolveManifestPath } from './opencli-entry.mjs'
import { loadExecutionPolicy } from './policy.mjs'
import { createCatalogService } from './catalog-service.mjs'

// Node >= 20:与 @jackwener/opencli 的 engines 持平(能跑 opencli 的机器就能跑 Host)。
// 注:20 已 EOL,是"最低可运行"而非推荐;推荐当前 LTS(22/24)。
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
if (nodeMajor < 20) {
  console.error(`[opencli-host] Node >= 20 required; got ${process.versions.node}`)
  process.exit(1)
}
```
（其余部分保持不动。）

- [ ] **Step 5: 三门 + 提交**

Run: `npx tsc --noEmit && npm test && npm run build`；另跑 `node scripts/sync-catalog.mjs --help 2>/dev/null || true` 确认脚本 import 不炸（无 --help 则跳过，仅确保模块解析）。
```bash
git add src/shared server/catalog-service.mjs server/index.mjs scripts/sync-catalog.mjs src/data/catalog.ts package.json
git add -u src/data   # 记录被删的两个 .ts
git commit -m "refactor(shared): normalize/catalogSchema 转 .mjs+.d.mts 消除运行时 .ts import;Node 门槛 23→20 与 opencli engines 持平"
```

---

### Task 2: readiness JSON 协议 + 五分支（Host 侧）

**Files:** Modify `server/index.mjs`；Test: Create `server/readiness.test.mjs`

**Interfaces:** Produces stdout 恰一行判定 JSON：成功 `{"opencliHostReady":true,"port":<number>,"pid":<number>,"opencliVersion":"…","policyCommands":<number>}`；失败 `{"opencliHostReady":false,"error":{"summary":"…","detail":"…"}}` 且非零退出。

- [ ] **Step 1: 写失败测试** `server/readiness.test.mjs`（`// @vitest-environment node`；用 `spawn` 真起 `server/index.mjs`，`OPENCLI_HOST_PORT=0`，读首行 JSON）

```js
// @vitest-environment node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), 'index.mjs')

function startHost(env = {}) {
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, OPENCLI_HOST_PORT: '0', ...env },
    shell: false,
    windowsHide: true,
  })
  const firstJson = new Promise((resolvePromise, rejectPromise) => {
    let buf = ''
    const timer = setTimeout(() => rejectPromise(new Error(`readiness timeout; got: ${buf}`)), 20000)
    child.stdout.on('data', (chunk) => {
      buf += chunk
      for (const line of buf.split('\n')) {
        if (!line.includes('opencliHostReady')) continue
        clearTimeout(timer)
        try { resolvePromise(JSON.parse(line)) } catch (e) { rejectPromise(e) }
        return
      }
    })
    child.once('error', rejectPromise)
    child.once('exit', (code) => { clearTimeout(timer); rejectPromise(new Error(`exited ${code} before readiness; got: ${buf}`)) })
  })
  return { child, firstJson }
}

describe('readiness 协议', () => {
  it('成功:恰一行机器可读 JSON,含真实随机端口与 policy 计数', async () => {
    const { child, firstJson } = startHost()
    try {
      const ready = await firstJson
      expect(ready.opencliHostReady).toBe(true)
      expect(Number.isInteger(ready.port)).toBe(true)
      expect(ready.port).toBeGreaterThan(0)
      expect(ready.pid).toBe(child.pid)
      expect(typeof ready.opencliVersion).toBe('string')
      expect(ready.policyCommands).toBeGreaterThan(0)
      // 端口真的在监听:能连上 /health
      const res = await fetch(`http://127.0.0.1:${ready.port}/health`, { headers: { Origin: 'http://127.0.0.1:5173' } })
      expect(res.status).toBe(200)
    } finally { child.kill('SIGKILL') }
  }, 30000)

  it('协议内失败:catalog 快照不可读 → ready:false + error,且非零退出', async () => {
    const { child, firstJson } = startHost({ OPENCLI_HOST_CATALOG_PATH: 'C:/definitely/not/here.json' })
    const ready = await firstJson.catch((e) => e)
    expect(ready.opencliHostReady).toBe(false)
    expect(typeof ready.error.summary).toBe('string')
    const code = await new Promise((r) => child.once('exit', r))
    expect(code).not.toBe(0)
  }, 30000)
})
```

- [ ] **Step 2: 跑红** `npx vitest run server/readiness.test.mjs` → FAIL（当前 stdout 是人读文案、无 `OPENCLI_HOST_CATALOG_PATH`）。

- [ ] **Step 3: 实现**（`server/index.mjs`）

1. catalog 路径可注入（供测试造协议内失败）：`const catalogPath = process.env.OPENCLI_HOST_CATALOG_PATH ?? resolve(projectRoot, 'public/catalog.snapshot.json')`
2. 把 `loadExecutionPolicy` / `resolveOpenCliEntry` / `resolveManifestPath` / `listen` 全部包进 try/catch，失败即：
```js
function failReady(summary, detail) {
  process.stdout.write(`${JSON.stringify({ opencliHostReady: false, error: { summary, detail } })}\n`)
  process.exit(1)
}
```
3. listen 成功后**第一件事**打印判定行（在任何人读日志之前）：
```js
const actualPort = typeof address === 'object' && address ? address.port : port
process.stdout.write(`${JSON.stringify({
  opencliHostReady: true,
  port: actualPort,
  pid: process.pid,
  opencliVersion: policy.opencliVersion,
  policyCommands: policy.allowedCommands.size,
})}\n`)
```
（原有人读 `console.log` 保留在其后，不影响机器解析——消费方只认含 `opencliHostReady` 的行。）

- [ ] **Step 4: 跑绿 + 三门**  - [ ] **Step 5: 提交**
```bash
git add server/index.mjs server/readiness.test.mjs
git commit -m "feat(host): readiness JSON 协议(成功/协议内失败两形态)+catalog 路径可注入,供 Tauri 机器可读判定"
```

---

### Task 3: runtime lockfile + build-host-runtime + SHA-256 清单

**Files:** Create `host-runtime/package.json`、`host-runtime/package-lock.json`（提交）、`scripts/build-host-runtime.mjs`；Modify `package.json`(scripts)、`.gitignore`(加 `dist-host/`)

**Interfaces:** Produces `dist-host/`（拓扑见 spec §3）+ `dist-host/runtime-manifest.json`；`npm run build:host`。

- [ ] **Step 1: 建 runtime lockfile**

`host-runtime/package.json`：
```json
{
  "name": "opencli-app-host-runtime",
  "private": true,
  "version": "0.0.0",
  "description": "Pinned OpenCLI production tree bundled into the desktop app (see docs/specs/2026-07-25-p1-tauri-packaging-design.md §3)",
  "dependencies": { "@jackwener/opencli": "1.8.6" }
}
```
Run 生成锁文件（**必须提交**）：
```bash
cd host-runtime && npm install --package-lock-only --omit=dev && cd ..
```

- [ ] **Step 2: 写 `scripts/build-host-runtime.mjs`**

```js
// 生成自包含 Host runtime 到 dist-host/。
// 铁律:dist-host 必须镜像仓内相对拓扑(server/ 用相对 import 引 ../src/shared/*.mjs),拍平必断。
// 可复现性:opencli 及其 production 依赖由 host-runtime/package-lock.json 钉死,用 npm ci 安装。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist-host')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// 1) 固定版 OpenCLI production tree(npm ci 严格按 lockfile)
cpSync(join(root, 'host-runtime/package.json'), join(out, 'package.json'))
cpSync(join(root, 'host-runtime/package-lock.json'), join(out, 'package-lock.json'))
execFileSync(process.execPath, [process.env.npm_execpath ?? 'npm', 'ci', '--omit=dev'], {
  cwd: out, stdio: 'inherit', shell: false,
})

// 2) 镜像拓扑拷贝(server + src/shared + public 快照)
cpSync(join(root, 'server'), join(out, 'server'), { recursive: true, filter: (p) => !p.endsWith('.test.mjs') })
cpSync(join(root, 'src/shared'), join(out, 'src/shared'), { recursive: true, filter: (p) => !p.includes('.test.') })
mkdirSync(join(out, 'public'), { recursive: true })
cpSync(join(root, 'public/catalog.snapshot.json'), join(out, 'public/catalog.snapshot.json'))

// 3) 全树 SHA-256 清单(校验用)
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}
const files = walk(out).filter((p) => !p.endsWith('runtime-manifest.json')).sort()
const entries = files.map((p) => ({
  path: relative(out, p).replace(/\\/g, '/'),
  sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
}))
writeFileSync(join(out, 'runtime-manifest.json'), JSON.stringify({ fileCount: entries.length, files: entries }, null, 2))
console.log(`[build-host-runtime] ${entries.length} files -> ${out}`)
```

`package.json` scripts 加：`"build:host": "node scripts/build-host-runtime.mjs"`；`.gitignore` 加 `dist-host/`。

- [ ] **Step 3: 跑一次并肉眼核拓扑**

Run:
```bash
npm run build:host && ls dist-host && ls dist-host/src/shared && ls dist-host/node_modules/@jackwener
```
Expected：`server/ src/ public/ node_modules/ package.json package-lock.json runtime-manifest.json`；`src/shared` 下有 4 个文件；`node_modules/@jackwener/opencli` 存在。

- [ ] **Step 4: 三门 + 提交**（`npm test` 不受影响，仍须跑）
```bash
git add host-runtime scripts/build-host-runtime.mjs package.json .gitignore
git commit -m "feat(build): host-runtime lockfile(npm ci --omit=dev)+build-host-runtime 生成镜像拓扑闭包+SHA-256 清单"
```

---

### Task 4: 🔴 隔离闭包硬闸（不过则回 T1-T3，T5+ 不开工）

**Files:** Create `scripts/verify-host-closure.mjs`；Modify `package.json`(scripts)

- [ ] **Step 1: 写验证脚本 `scripts/verify-host-closure.mjs`**

要点（实现者按此写成真断言，失败即非零退出）：
1. 把 `dist-host/` 整树复制到 **`os.tmpdir()` 下的新目录**（保证**无任何祖先 `node_modules`**——这是本 gate 的全部意义）。
2. 用 `spawn(process.execPath, [<tmp>/server/index.mjs], { env: { OPENCLI_HOST_PORT: '0' }, shell: false })` 起 Host；读 readiness JSON（复用 T2 的行协议，超时 30s）。
3. 断言链（任一失败即整体失败并打印 stderr 尾部）：
   - `opencliHostReady === true`，`port > 0`
   - `GET /health` → 200
   - `GET /catalog` → 200 且 `commands.length > 1000`（**真 spawn 内置 opencli list**，证明 opencli 闭包成立）
   - `POST /start` 跑 `36kr/news`（`argv: ['36kr','news','-f','json']`）→ 202，经 `/events` 收到 `done` 且 `outcome==='success'`
   - `runtime-manifest.json` 逐文件重算 SHA-256 一致、`fileCount` 相符
4. 结束 kill 子进程、清临时目录。

`package.json` 加 `"verify:host": "node scripts/verify-host-closure.mjs"`。

- [ ] **Step 2: 执行硬闸**

Run: `npm run build:host && npm run verify:host`
Expected: 全部断言通过、退出码 0。

**🔴 若失败**：按报错回补闭包（多半是漏拷模块或 opencli 依赖缺项），**修到通过为止**；仍不通过则停下报 BLOCKED，回设计。

- [ ] **Step 3: 提交**
```bash
git add scripts/verify-host-closure.mjs package.json
git commit -m "test(build): 隔离闭包硬闸——无祖先 node_modules 临时目录跑通 readiness/health/catalog/start+清单校验"
```

---

### Task 5: Tauri 脚手架 + supervisor（Job Object + stdin EOF 双通道 + 单实例）

**Files:** Create `src-tauri/`（`Cargo.toml`、`tauri.conf.json`、`build.rs`、`src/main.rs`、`src/lib.rs`、`src/host_supervisor.rs`、`icons/`）；Modify `package.json`(devDeps + scripts)

**依赖**：T4 硬闸已过。

- [ ] **Step 1: 脚手架**

`package.json` devDependencies 加 `"@tauri-apps/cli": "^2"`，dependencies 加 `"@tauri-apps/api": "^2"`；scripts 加 `"tauri": "tauri"`。
`src-tauri/Cargo.toml`：
```toml
[package]
name = "opencli-app-clone"
version = "0.1.0"
edition = "2021"

[lib]
name = "opencli_app_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-single-instance = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
  "Win32_Foundation",
  "Win32_System_JobObjects",
  "Win32_System_Threading",
] }
```
`build.rs`：`fn main() { tauri_build::build() }`
图标：`npx tauri icon`（或先放占位 PNG，真机门前替换）。

- [ ] **Step 2: `src/host_supervisor.rs` —— 核心不变式**

实现要求（**不变式不可协商，API 细节以编译通过为准**）：

```rust
// 不变式（对应 spec §4/§5）:
// I1. spawn 后**立即** AssignProcessToJobObject(job with KILL_ON_JOB_CLOSE) —— 覆盖主进程崩溃/强杀
// I2. stdin 管道**保持打开且不写** —— Host 侧监听 EOF 自退,覆盖 Job 分配失败
// I3. Job 分配失败 → 记录降级继续(靠 I2);若 stdin 也不可用 → fail-closed,不启动
// I4. **持续排空 stdout/stderr 直到进程退出** —— 读到 readiness 行就停会背压死锁子进程
// I5. readiness 五分支各自可辨:spawn 失败 / 版本不达标 / ready:false / 超时 / 进程异常

pub enum HostStartError {
    NodeMissing { detail: String },
    NodeTooOld { found: String, required: &'static str },
    HostReportedFailure { summary: String, detail: Option<String> },
    ReadinessTimeout { stderr_tail: String },
    ProcessFailed { code: Option<i32>, stderr_tail: String },
}

pub struct HostHandle { pub port: u16, pub pid: u32, /* child, job, stdin 保存于此 */ }

pub fn probe_node() -> Result<(), HostStartError>;               // node --version,解析 major >= 20
pub fn start_host(resource_dir: &std::path::Path) -> Result<HostHandle, HostStartError>;
pub fn shutdown(handle: HostHandle);                              // 关 stdin → 等 2s → taskkill /T /F → drop job
```

- `start_host` 用 `std::process::Command::new("node")`，args `[resource_dir/host/server/index.mjs]`，`env("OPENCLI_HOST_PORT", "0")`，`stdin(Stdio::piped())`、`stdout(Stdio::piped())`、`stderr(Stdio::piped())`。
- 两个后台线程分别排空 stdout/stderr（I4）；stdout 线程把含 `opencliHostReady` 的首行经 channel 送回主线程，之后**继续读到 EOF**。
- 主线程 `recv_timeout(15s)` 取判定；超时 → `ReadinessTimeout`（附 stderr 尾部）。
- Job：`CreateJobObjectW` + `SetInformationJobObject(JobObjectExtendedLimitInformation, LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)` + `AssignProcessToJobObject(job, child_handle)`；handle 存进 `HostHandle` 保活（drop 即触发连坐）。

- [ ] **Step 3: Host 侧 stdin EOF 看门狗**（`server/index.mjs`，本 task 一并加）

```js
// 父进程存活通道(spec §5 通道 2):Tauri 保留 stdin 写端且不写入;父进程一旦消亡,
// 写端关闭 → 这里收到 EOF → 自行优雅退出,覆盖 Job 分配失败的场景。
if (process.env.OPENCLI_HOST_PARENT_WATCH === '1') {
  process.stdin.resume()
  process.stdin.on('end', () => { void shutdown().finally(() => process.exit(0)) })
  process.stdin.on('close', () => { void shutdown().finally(() => process.exit(0)) })
}
```
（Rust 侧设 `OPENCLI_HOST_PARENT_WATCH=1`；不设时行为与今天完全一致，`npm run dev:server` 不受影响。）

- [ ] **Step 4: `src/lib.rs` 接线**

- **`tauri_plugin_single_instance` 最先注册**（早于任何 host bootstrap）。
- `.setup(|app| { … })` 内：`probe_node()` → `start_host(resource_dir)` → 成功则 T6 建窗；失败则 T6 错误视图。
- `on_window_event` / `RunEvent::ExitRequested` 调 `shutdown(handle)`。

- [ ] **Step 5: 编译 + 三门 + 提交**

Run: `cd src-tauri && cargo build && cd .. && npx tsc --noEmit && npm test && npm run build`
```bash
git add src-tauri package.json server/index.mjs
git commit -m "feat(tauri): 脚手架+supervisor 双通道进程托管(Job Object KILL_ON_JOB_CLOSE + stdin EOF 看门狗 + fail-closed)+单实例先于 bootstrap"
```

---

### Task 6: 窗口时机 + boot 注入 + 五类错误视图

**Files:** Modify `src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json`；Create `src-tauri/error.html`

- [ ] **Step 1: `tauri.conf.json` 关键项**

```json
{
  "productName": "OpenCLI App Clone",
  "identifier": "dev.lauseusing.opencli-app-clone",
  "build": { "frontendDist": "../dist", "beforeBuildCommand": "npm run build && npm run build:host" },
  "app": {
    "windows": [],
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:*"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis", "msi"],
    "resources": { "../dist-host/": "host/" },
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/icon.ico"]
  }
}
```
（`windows: []` = 不自动建窗；`resources` **必须 map 形式**，数组形式会落成 `_up_/dist-host/…`。）

- [ ] **Step 2: 建窗与 boot 注入**（`lib.rs`）

```rust
let boot = serde_json::json!({ "baseUrl": format!("http://127.0.0.1:{}", handle.port), "hostPid": handle.pid });
let script = format!("window.__OPENCLI_BOOT__ = {};", serde_json::to_string(&boot)?);   // JSON 转义,防注入
tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
    .title("OpenCLI App Clone")
    .inner_size(1280.0, 800.0)
    .initialization_script(&script)      // 必须在页面加载前
    .build()?;
```

- [ ] **Step 3: 五类错误视图**（同一 builder，指向 `error.html`，用 query 传分类与详情）

`src-tauri/error.html`：静态页，读 `location.search` 渲染 `kind`/`summary`/`detail`，五种 `kind` 文案：
- `node-missing`：未找到 Node —— 请安装 Node（最低 20，**推荐当前 LTS 22/24**）
- `node-too-old`：Node 版本过低（显示检测到的版本 + 最低 20 + 推荐 LTS）
- `host-failed`：Host 报告启动失败（显示服务端 `summary`/`detail`）
- `timeout`：Host 启动超时（附 stderr 尾部）
- `process-failed`：Host 异常退出（退出码 + stderr 尾部）

- [ ] **Step 4: 编译 + 三门 + 提交**
```bash
git add src-tauri
git commit -m "feat(tauri): Host ready 后建窗+boot 配置注入(JSON 转义)+五类错误视图;CSP connect-src 容纳回环随机端口"
```

---

### Task 7: 前端唯一 baseUrl（HostSelection → App → AppShell → HealthPill）

**Files:** Modify `src/host/index.ts`、`src/main.tsx`、`src/App.tsx`、`src/components/AppShell.tsx`、`src/components/HealthPill.tsx`；Test: `src/host/catalogSource.test.ts`(或 index.test.ts)、`src/components/HealthPill.test.tsx`、`src/App.test.tsx`

- [ ] **Step 1: 写失败测试**（关键三条）

1. `createHostSelection({ boot: { baseUrl: 'http://127.0.0.1:54321' } })` → 返回的 `baseUrl` 为该值，且 `catalogSource`/`host` 都指向它（断言 fetch 收到的 URL 前缀）。
2. 优先级：`boot > search(?host=node) > env > 默认 43117`。
3. **五端点同端口**：注入 `baseUrl` 后渲染 App，断言 `/health`、`/catalog`、`/events`、`/start`、`/cancel` 的请求 URL 全部以同一 `http://127.0.0.1:<port>` 开头（用 fetch/EventSource mock 收集 URL）。

- [ ] **Step 2: 跑红** → 当前 HealthPill 自读 env、必然打到 43117。

- [ ] **Step 3: 实现**

- `src/host/index.ts`：`HostSelection` 加 `baseUrl: string`；入参加 `boot?: { baseUrl?: string }`；解析优先级如上；demo 模式 `baseUrl` 仍返回默认值（HealthPill 在 demo 下不 ping）。
- `src/main.tsx`：读 `window.__OPENCLI_BOOT__`（`declare global` 补类型）传入 `createHostSelection`，并把 `baseUrl` 作为 prop 传 `<App>`。
- `src/App.tsx`：新增 prop `baseUrl?: string`，透传 `<AppShell baseUrl={baseUrl}>`。
- `src/components/AppShell.tsx`：新增 prop `baseUrl?: string`，传 `<HealthPill baseUrl={baseUrl} />`。
- `src/components/HealthPill.tsx`：**删掉自读 `import.meta.env` 与 `DEFAULT_NODE_HOST_URL` 的分支**，改用 prop（缺省仍回落默认常量，供既有测试与 demo）。

- [ ] **Step 4: 跑绿 + 三门 + 提交**
```bash
git add src/host/index.ts src/main.tsx src/App.tsx src/components/AppShell.tsx src/components/HealthPill.tsx src/host/*.test.ts src/components/HealthPill.test.tsx src/App.test.tsx
git commit -m "fix(front): baseUrl 单一事实源(boot>query>env>默认)经 props 贯穿到 HealthPill,消灭随机端口下的假离线;五端点同端口断言"
```

---

### Task 8: CORS 真实 Origin 捕获 + 打包配置收口

**Files:** Modify `src-tauri/src/lib.rs`（注入 `OPENCLI_HOST_ALLOWED_ORIGINS`）、`docs/specs/2026-07-25-p1-tauri-packaging-design.md`（回填实测 Origin）

- [ ] **Step 1: 实测捕获生产 Origin**

Run: `npm run tauri build`（首次较慢），装 NSIS 包并启动 → 前端会因 CORS 被拒 → 从 Host 日志/DevTools 读**实际 `Origin` 头**（Windows 上通常 `http://tauri.localhost`，**以实测为准，不猜**）。把值记进报告与 spec。

- [ ] **Step 2: 精确加白**

`lib.rs` 起 Host 时注入：`.env("OPENCLI_HOST_ALLOWED_ORIGINS", "<实测 Origin>")`（**只写实测那一个**；开发态另行走 `npm run dev` + 现有 5173 白名单，不混用）。

- [ ] **Step 3: 重装验证 + 提交**
```bash
git add src-tauri/src/lib.rs docs/specs/2026-07-25-p1-tauri-packaging-design.md
git commit -m "fix(tauri): 生产 WebView Origin 实测捕获后精确加白(不猜测/不放宽多个),守住 DNS-rebinding 防线"
```

---

### Task 9: 真机发布门（人工，controller 执行）

**不写代码**。装 **MSI** 与 **NSIS** 两种包，**每种包各跑一遍全表**，逐条验并记录进 ledger。

**取证纪律（评审要求）**：每次验收都记下 ① 实际安装到的 exe 绝对路径 ② 主进程与 Host 的 pid **及各自 CommandLine**（`Get-CimInstance Win32_Process`）③ 退出码。只凭 pid 判存活会被 **pid 复用**骗，只凭"进程名没了"会被**上一轮残留**骗——两者都会把失败读成通过。

**验收报告（证据全文）**：`docs/releases/2026-07-26-p1-a-tauri-packaging-t9.md`

- [x] 安装后启动成功（**SxS 结论以此为准**）—— 用户从资源管理器真实安装，主进程与 Host 全部解析到真实 `%LOCALAPPDATA%`，命中容器路径的进程 0 个
- [x] 目录渲染 1278 命令 / 175 站点 —— **Host 层已证**（`/catalog` 真刷新）；**UI 目视待补**
- [x] 跑 `36kr/news` 出真实结果表 —— **Host 层已证**（142 output → `success`，真实条目）；**UI 表目视待补**
- [x] 关窗口 → 进程树验收：`node` 与 opencli 后代**全部消失**
- [x] `taskkill /F` 强杀主进程 → 复验子树同样消失（含 opencli 孙进程，10ms 内逮到后当场强杀）
      ⚠️ **这一条只证"猝死时子树确实消失"这个结果，证不了是哪条通道干的**——正常路径里 Job Object 与 stdin EOF 同时在场。stdin EOF 通道的证据在 `scripts/verify-parent-watch.mjs`（T8.5，带零假设对照组），本门不重复承担。
- [x] `node scripts/verify-parent-watch.mjs` → 对照组存活 + 实验组自退（对**将要发的那份 dist-host** 复跑一次）
- [ ] **收藏重启持久化**：收藏站点/命令 → 完全退出 → 重开 → 收藏仍在 —— 需 UI 操作
- [x] **运行闭环**：启动 → SSE 输出可见 → 取消 → 终态 `cancelled`（Host 层；UI 目视待补）
- [ ] Node 缺失/过低场景（临时改 PATH）→ 引导视图正确显示 —— 需 UI 目视
- [ ] **MSI 包安装 + 全表复跑** —— `msiexec /qn` 返 1603 / Error 1925，per-machine 包需提权，非包缺陷

**预期行为，不要记成缺陷**：启动期约 1s 无窗口（spec §10）。

## Self-review 记录

- Spec 覆盖：§2→T5/T6；§3→T1/T3；§4→T2；§5→T5；§6→T7；§7→T6/T8；§8→T6；§9→T4/T9；§11 依赖序与本计划一致。
- 依赖序无环：T1(去 .ts)→T2(readiness)→T3(闭包生成)→**T4 硬闸**→T5(supervisor)→T6(窗口/错误视图)→T7(前端 baseUrl)→T8(Origin)→T9(人工门)。
- 类型/接口一致：`src/shared/*.mjs` 的导出名与原 `.ts` 逐字相同；`HostStartError` 五分支与 spec §4 表一一对应；`baseUrl` 由 T7 产、T6 的 boot 注入消费。
- 占位符：T4/T5 的部分实现以「不变式 + 要求」给出而非逐行代码（Rust/Tauri 的 API 细节需以编译通过为准），已明确标注不变式不可协商；其余步骤给全代码。
