// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VkRuntimeManager } from './vk-runtime.mjs'

const dirs = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

function bundleDir() {
  const dir = tempDir('vk-bundle-')
  writeFileSync(join(dir, 'runtime-manifest.json'), '{}')
  return dir
}

describe('VkRuntimeManager', () => {
  it('无捆绑件 → not-available(bundle-missing)', () => {
    const manager = new VkRuntimeManager({ home: tempDir('vk-home-'), bundleDir: undefined })
    expect(manager.status()).toMatchObject({ state: 'not-available', reasonCode: 'bundle-missing' })
  })

  it('有捆绑件无 active → not-installed;安装成功后 installed(读 active 指针)', async () => {
    const home = tempDir('vk-home-')
    const manager = new VkRuntimeManager({
      home,
      bundleDir: bundleDir(),
      installImpl: async ({ log }) => {
        log('step one')
        const python = join(home, 'runtime', 'versions', 'v1', 'python.exe')
        mkdirSync(join(home, 'runtime', 'versions', 'v1'), { recursive: true })
        writeFileSync(python, 'stub')
        writeFileSync(join(home, 'runtime', 'active.json'), JSON.stringify({ version: 'v1', pythonPath: python }))
        return { version: 'v1', pythonPath: python }
      },
    })
    expect(manager.status().state).toBe('not-installed')
    await manager.install()
    const status = manager.status()
    expect(status.state).toBe('installed')
    expect(status.version).toBe('v1')
    expect(status.log).toContain('step one')
  })

  it('安装失败 → failed(带 reasonCode 与日志),可重试;单飞不并发', async () => {
    let calls = 0
    let release
    const gate = new Promise((resolveGate) => { release = resolveGate })
    const manager = new VkRuntimeManager({
      home: tempDir('vk-home-'),
      bundleDir: bundleDir(),
      installImpl: async ({ log }) => {
        calls += 1
        log('trying')
        await gate
        const error = new Error('磁盘可用空间不足')
        error.reasonCode = 'disk'
        throw error
      },
    })
    const first = manager.install().catch((err) => err)
    const second = manager.install().catch((err) => err)   // 单飞:共享同一次
    expect(manager.status().state).toBe('installing')
    release()
    await first
    await second
    expect(calls).toBe(1)
    const status = manager.status()
    expect(status.state).toBe('failed')
    expect(status.reasonCode).toBe('disk')
    expect(status.log).toContain('trying')
  })
})
