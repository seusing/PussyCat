import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { stripBom, mergeManifestFields } from '../src/data/normalize.ts'
import { assertCatalogCommands } from '../src/data/catalogSchema.ts'
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
  let failActive         // 在途 runList 的 fail 引用,close() 时主动 reject(fakeChild kill 不会自动 emit close)
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
    try {
      assertCatalogCommands(commands)
    } catch (e) {
      throw new CatalogServiceError(500, e instanceof Error ? e.message : 'Catalog schema invalid')
    }
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
      failActive?.(new CatalogServiceError(500, 'Catalog service is closed'))
    },
  }
}
