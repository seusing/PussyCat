import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHostServer } from './host-server.mjs'
import { resolveOpenCliEntry, resolveManifestPath } from './opencli-entry.mjs'
import { loadExecutionPolicy } from './policy.mjs'
import { createCatalogService } from './catalog-service.mjs'
import { VkSidecarManager } from './vk-sidecar.mjs'
import { createVkJobShadow } from './vk-job-shadow.mjs'
import { VkRuntimeManager } from './vk-runtime.mjs'

// Node >= 20:与 @jackwener/opencli 的 engines 持平(能跑 opencli 的机器就能跑 Host)。
// 注:20 已 EOL,是"最低可运行"而非推荐;推荐当前 LTS(22/24)。
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
if (nodeMajor < 20) {
  console.error(`[opencli-host] Node >= 20 required; got ${process.versions.node}`)
  process.exit(1)
}

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
// OPENCLI_HOST_CATALOG_PATH 是测试注入点(供 readiness.test.mjs 制造协议内失败);默认行为不变。
const catalogPath = process.env.OPENCLI_HOST_CATALOG_PATH ?? resolve(projectRoot, 'public/catalog.snapshot.json')
const host = process.env.OPENCLI_HOST_ADDRESS ?? '127.0.0.1'
const port = Number.parseInt(process.env.OPENCLI_HOST_PORT ?? '43117', 10)
const allowedOrigins = (process.env.OPENCLI_HOST_ALLOWED_ORIGINS
  ?? 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

// 机器可读启动判定(供 Tauri supervisor 消费):
// 协议内失败是 Host 自知的合法响应形态,与"进程异常/非法 JSON"是不同分支——这里只负责把它说清楚。
function failReady(summary, detail) {
  const line = `${JSON.stringify({ opencliHostReady: false, error: { summary, detail } })}\n`
  // process.exit() 会丢掉 stdout 里尚未排空的部分(管道写并非在所有平台都同步)。判定行是
  // supervisor 唯一的结构化线索:丢了它,"协议内失败"会被误判成 process-failed —— 两者给用户的
  // 文案与排障方向完全不同。故等写入回调再退;另挂一个 unref 的兜底定时器,免得"永远排不空"
  // 把进程挂死 —— 挂死会退化成 readiness-timeout,比丢判定行更糟。
  process.exitCode = 1
  process.stdout.write(line, () => process.exit(1))
  setTimeout(() => process.exit(1), 500).unref()
}

// app 在启动成功前一直是 null:父进程可能死在它建成之前,shutdown 必须能应付那一刻。
let app = null
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  await app?.close()
}

// 父进程存活通道(spec §5 通道 2):Tauri 保留本进程 stdin 的写端且**从不写入**;
// 父进程一旦消亡(含崩溃/被强杀),写端关闭 → 这里收到 EOF → 自行优雅退出。
// 这条不依赖 Job Object,正是用来覆盖 Job 分配失败的场景。
// 开关默认关闭:不设 OPENCLI_HOST_PARENT_WATCH 时一切行为与今天完全一致(npm run dev:server 不受影响)。
//
// 注册点在**一切初始化之前**(评审 P1)。诚实交代:今天 listen 之前的启动路径恰好全是同步的,
// 而同步块本就不可能被 EOF 事件抢占 —— 所以这次上移对当前代码是行为等价的,不为它编造行为测试。
// 上移的理由是**拆掉这份偶然依赖**:哪天目录加载改成异步(比如去读远端 manifest),
// "通道 2 从进程第一刻起就成立"这条不变式不该跟着悄无声息地破掉。
// 它仍然在打印判定行之前:判定行要如实上报 parentWatch,supervisor 靠这个字段决定通道 2 到底有没有。
let parentWatch = false
if (process.env.OPENCLI_HOST_PARENT_WATCH === '1') {
  let parentGone = false
  const exitOnParentGone = () => {
    // end 与 close 都会来;只认第一次,避免 shutdown 未完成就被第二次调用抢跑 process.exit。
    if (parentGone) return
    parentGone = true
    void shutdown().finally(() => process.exit(0))
  }
  process.stdin.resume()
  process.stdin.on('end', exitOnParentGone)
  process.stdin.on('close', exitOnParentGone)
  parentWatch = true
}

try {
  const policy = loadExecutionPolicy(catalogPath)
  const opencliEntry = resolveOpenCliEntry()
  const catalogService = createCatalogService({
    opencliEntry,
    resolveManifest: () => resolveManifestPath(opencliEntry),
  })
  // video-knowledge sidecar(vk-shell-v1 契约):未配置时照常启动,/vk/v1/*
  // 返回类型化诊断;配置后首个请求按需拉起。v2 阶段3:HOME 指数据根,
  // python 优先 env、否则 spawn 时读 active.json(装完免重启)。
  const vkHome = process.env.OPENCLI_HOST_VK_HOME
  const vkSidecar = new VkSidecarManager({
    pythonPath: process.env.OPENCLI_HOST_VK_PYTHON,
    homeDir: vkHome,
    rootDir: process.env.OPENCLI_HOST_VK_ROOT
      ?? (vkHome ? resolve(vkHome, 'data') : undefined),
    configDir: process.env.OPENCLI_HOST_VK_CONFIG_DIR
      ?? (vkHome ? resolve(vkHome, 'config') : undefined),
  })
  const vkStateDir = process.env.OPENCLI_HOST_VK_STATE_DIR
    ?? (vkHome ? resolve(vkHome, 'node-state') : undefined)
  const vkJobShadow = createVkJobShadow({
    stateFile: vkStateDir ? resolve(vkStateDir, 'vk-job-shadow.json') : undefined,
  })
  const vkRuntime = new VkRuntimeManager({
    home: vkHome,
    bundleDir: process.env.OPENCLI_HOST_VK_BUNDLE_DIR,
  })
  app = createHostServer({
    opencliEntry,
    policy,
    catalogService,
    allowedOrigins,
    vkSidecar,
    vkJobShadow,
    vkRuntime,
    runManagerOptions: {
      cancelGraceMs: Number.parseInt(process.env.OPENCLI_HOST_CANCEL_GRACE_MS ?? '2000', 10),
      commandTimeoutMs: Number.parseInt(process.env.OPENCLI_HOST_COMMAND_TIMEOUT_MS ?? '90000', 10),
      maxConcurrentRuns: Number.parseInt(process.env.OPENCLI_HOST_MAX_CONCURRENT_RUNS ?? '1', 10),
    },
  })

  const address = await app.listen({ host, port })

  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })

  // listen 成功后第一时间打印判定行,先于任何人读日志——消费方(Tauri supervisor)只认含 opencliHostReady 的行。
  const actualPort = typeof address === 'object' && address ? address.port : port
  process.stdout.write(`${JSON.stringify({
    opencliHostReady: true,
    port: actualPort,
    pid: process.pid,
    opencliVersion: policy.opencliVersion,
    policyCommands: policy.allowedCommands.size,
    // 通道 2 的**事实**(监听已注册),不是"我们设过环境变量"的意图。
    // dist-host/ 是 gitignore 的构建产物,版本会漂移——supervisor 不能拿自己设的环境变量当证据。
    parentWatch,
  })}\n`)

  const printableAddress = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${host}:${port}`
  console.log(`[opencli-host] listening on http://${printableAddress}`)
  console.log(`[opencli-host] OpenCLI ${policy.opencliVersion}: ${opencliEntry}`)
  console.log(`[opencli-host] policy: ${policy.description} (${policy.allowedCommands.size} commands)`)
  console.log(`[opencli-host] parent-watch(stdin EOF): ${parentWatch ? 'on' : 'off'}`)
} catch (error) {
  failReady(
    error instanceof Error ? error.message : 'Host failed to start',
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  )
}
