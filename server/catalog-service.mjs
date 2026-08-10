import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { stripBom, mergeManifestFields } from '../src/shared/normalize.mjs'
import { assertCatalogCommands } from '../src/shared/catalogSchema.mjs'
import { buildExecutionPolicy } from './policy.mjs'
import { POLICY_SCHEMA_VERSION, canonicalJson } from './policy-fingerprint.mjs'

export class CatalogServiceError extends Error {
  constructor(statusCode, message, detail) {
    super(message)
    this.name = 'CatalogServiceError'
    this.statusCode = statusCode
    this.detail = detail
  }
}

// 现场重生成 catalog:spawn opencli list(P0-B 同款安全姿势)→ manifest merge → schema 校验
// → buildExecutionPolicy → 算 revision → 全部成功后单引用原子替换
// {snapshot, policy, revision, generatedAt};任一失败旧值不动。
export function createCatalogService({
  opencliEntry,
  resolveManifest,
  initialSnapshot,
  spawnImpl = spawn,
  readFileImpl = readFileSync,
  now = Date.now,
  timeoutMs = 15_000,
  maxOutputBytes = 8 * 1024 * 1024,
}) {
  let state              // { snapshot, policy, revision, generatedAt } | undefined —— 单引用,原子换
  let inflight           // Promise | undefined —— single-flight
  let activeChild        // 在途子进程,close() 时 kill
  let failActive         // 在途 runList 的 fail 引用,close() 时主动 reject(fakeChild kill 不会自动 emit close)
  let closed = false

  const runList = () => new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawnImpl(process.execPath, [opencliEntry, 'list', '-f', 'json'], {
        shell: false,
        windowsHide: true,
      })
    } catch (error) {
      rejectPromise(new CatalogServiceError(502, 'Failed to spawn opencli list', error instanceof Error ? error.message : String(error)))
      return
    }
    activeChild = child
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      if (activeChild === child) activeChild = undefined
      if (failActive === fail) failActive = undefined
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      child.kill('SIGKILL')
      rejectPromise(error)
    }
    failActive = fail
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

  const readOpencliVersion = (manifestPath) => {
    try {
      const raw = readFileImpl(join(dirname(manifestPath), 'package.json'), 'utf8')
      const version = JSON.parse(stripBom(String(raw))).version
      return typeof version === 'string' ? version : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  if (initialSnapshot) {
    assertCatalogCommands(initialSnapshot.commands)
    const policy = buildExecutionPolicy(initialSnapshot)
    const revision = createHash('sha256').update(canonicalJson({
      policySchemaVersion: POLICY_SCHEMA_VERSION,
      opencliVersion: initialSnapshot.opencliVersion,
      commands: initialSnapshot.commands,
      decisions: policy.decisions,
    })).digest('hex').slice(0, 16)
    const generatedAt = Number.isFinite(initialSnapshot.generatedAt)
      ? initialSnapshot.generatedAt
      : now()
    state = { snapshot: initialSnapshot, policy, revision, generatedAt }
  }

  const doRefresh = async () => {
    if (closed) throw new CatalogServiceError(500, 'Catalog service is closed')
    let manifestPath
    try {
      manifestPath = resolveManifest()   // fail-fast:缺 manifest 立即报,不必等 opencli list 跑满 15s(复审 F5)
    } catch (error) {
      throw new CatalogServiceError(500, 'Failed to resolve cli-manifest.json', error instanceof Error ? error.message : String(error))
    }
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
    try {
      assertCatalogCommands(commands)
    } catch (e) {
      throw new CatalogServiceError(500, e instanceof Error ? e.message : 'Catalog schema invalid')
    }
    const snapshot = {
      schemaVersion: 1,
      generatedAt: now(),
      opencliVersion: readOpencliVersion(manifestPath),
      source: 'live: opencli list -f json',
      listSha256: createHash('sha256').update(listRaw).digest('hex'),
      manifestSha256: createHash('sha256').update(manifestRaw).digest('hex'),
      commands,
    }
    const policy = buildExecutionPolicy(snapshot)
    // revision 让「snapshot 与 decisions 同源」在 wire 上**可验**(I-P4)——
    // 「可验」的定义是:客户端拿到 envelope 后能自己重算出同一个值。因此
    //   · 不含 now():掺了时间戳客户端就永远算不出来,那是不透明 nonce 不是摘要;
    //   · 取 commands **全文**而非 commands.length:长度相同内容不同会撞成同一个 revision;
    //   · **必须含 decisions**:revision 要证的正是「这份判决属于这份快照」,不含它就什么也没证。
    const revision = createHash('sha256').update(canonicalJson({
      policySchemaVersion: POLICY_SCHEMA_VERSION,
      opencliVersion: snapshot.opencliVersion,
      commands: snapshot.commands,
      decisions: policy.decisions,
    })).digest('hex').slice(0, 16)
    // generatedAt 是「**这份判决**何时生成」,所以内容没变就必须沿用旧时刻。
    // 光把它存进 state 达不到这个目的:端点每次请求都无条件 refresh(),state 每请求重建一次,
    // 于是 revision 相同而 generatedAt 不同 —— 正是要避免的自相矛盾,只是换了条路径。
    // 判据用 revision 而不是「快照是否全等」:revision 本就是内容摘要,现成且更便宜。
    const generatedAt = state?.revision === revision ? state.generatedAt : now()
    state = { snapshot, policy, revision, generatedAt }   // ← 全部成功后才替换,单引用原子
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
      failActive?.(new CatalogServiceError(500, 'Catalog service is closed'))
    },
  }
}
