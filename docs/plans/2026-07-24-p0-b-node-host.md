# P0-B 真实 Node Host Implementation Plan

**Goal:** 交付 `36kr/news` 的真实 OpenCLI 执行闭环，同时把 P0-B 的执行面限制在
PUBLIC/READ/browser=false。

**Architecture:** 前端继续只依赖 `HostBridge`；新增 `nodeBridgeHost` 通过 HTTP +
SSE 连接本地 Node Host。Host 直接 spawn 固定 OpenCLI Node 入口，RunManager 负责
流式切行、seq、done-once、JSON 结果、取消与超时。

## 分工

- **主代理**
  - 本 spec/plan、Node Host、OpenCLI 入口解析、执行策略、进程生命周期。
  - App/main/package 集成、真机 E2E、最终复核。
- **fast-worker**
  - Task 1：bool 键缺失硬化。
  - Task 4：`nodeBridgeHost`/host selector 的边界清晰实现与单测。

同一时间一个文件只由一个代理修改；主代理集成前复核子代理全部变更。

## Task 1：P0-B 前置 argv 硬化

**Files**
- Modify: `src/data/command.ts`
- Modify: `src/data/command.test.ts`

**Steps**
1. 用 `hasOwnProperty` 区分 bool 键缺失与显式 false。
2. 缺失键一律省略；存在键时才与 manifest 默认值比较。
3. 补 default=true/无默认两种缺失键测试。
4. 运行 `npx vitest run src/data/command.test.ts`。

## Task 2：固定 JSON argv 与 OpenCLI 依赖

**Files**
- Modify: `src/data/command.ts`
- Modify: `src/data/command.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Steps**
1. 预览与执行同源地加入 `-f json`，不得由 server 注入。
2. 固定依赖 `@jackwener/opencli@1.8.6`，与 catalog 快照版本一致。
3. 测试 argv/preview 都包含显式格式。

## Task 3：Node Host 核心

**Files**
- Create: `server/opencli-entry.mjs`
- Create: `server/policy.mjs`
- Create: `server/run-manager.mjs`
- Create: `server/host-server.mjs`
- Create: `server/index.mjs`
- Create: `server/*.test.mjs`

**Steps**
1. 测试并实现项目依赖的 Node entry 解析。
2. 测试并实现 catalog PUBLIC/READ/browser=false 策略及 argv 一致性校验。
3. 测试并实现 RunManager：
   - `process.execPath + entry + argv`
   - `shell:false`
   - stdout/stderr 切行 + per-run seq
   - done-once + JSON result
   - SIGTERM→2s→SIGKILL
   - 90s timeout
4. 测试并实现 HTTP/SSE：
   - health/events/start/cancel
   - CORS/Origin/content-type/body limit
   - SSE id/有限重放/heartbeat
5. 运行 server 定向测试。

## Task 4：前端 nodeBridgeHost 与选择器

**Files**
- Create: `src/host/nodeBridgeHost.ts`
- Create: `src/host/nodeBridgeHost.test.ts`
- Create: `src/host/index.ts`
- Create: `src/host/index.test.ts`

**Steps**
1. EventSource 建连并分发 `output/done`。
2. `startCommand` 等待 SSE open 后 POST `/start`。
3. `cancelCommand` POST `/cancel`，统一 HTTP 错误信息。
4. host selector 默认 mock，支持 env 与 `?host=node`。
5. 运行 host 定向测试。

## Task 5：App、状态与开发脚本集成

**Files**
- Modify: `src/main.tsx`
- Modify: `src/App.tsx`
- Modify: `src/store/appStore.ts`
- Modify: relevant tests
- Create: `.env.node`
- Modify: `package.json`

**Steps**
1. `main.tsx` 注入 selector 产出的 host，App 测试默认仍走 mock。
2. 真实 Host 时把顶部状态置为 connected。
3. 增加 `dev:server`、`dev:node`，保留原 `dev` mock 行为。
4. 补集成回归测试。

## Task 6：最终验证

1. `npm test`
2. `npm run build`
3. `git diff --check`
4. 启动 Node Host，检查 `/health`。
5. 通过 HTTP/SSE 真跑 `36kr/news -f json`。
6. 启动 Vite node 模式，在工作台选择 `36kr/news` 真跑，检查流日志、成功终态、
   五列表格。
7. 记录命令、版本、事件序列与结果行数；不把抓取结果提交进仓库。
