// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SHADOW_FIELDS, createVkJobShadow } from './vk-job-shadow.mjs'

const dirs = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'vk-shadow-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

describe('createVkJobShadow', () => {
  it('persists exactly the sanitized field whitelist — smuggled fields are structurally dropped', () => {
    const dir = tempDir()
    const shadow = createVkJobShadow({ stateFile: join(dir, 'vk-job-shadow.json') })
    shadow.recordSubmit({
      vkJobId: 'job-1',
      clientJobId: 'client-1',
      idempotencyKey: 'idem-1',
      // 走私字段：任何一个都不得落盘
      source: 'https://example.com/secret?xsec_token=abc',
      token: 'leak-me',
      argv: ['x'],
    })
    shadow.observeView({
      job_id: 'job-1',
      status: 'done',
      run_id: 'run-9',
      request_fingerprint: 'f'.repeat(64),
      request: { source: 'https://example.com/secret?xsec_token=abc' },
      outputs: { note_path: 'out_123' },
    })

    const raw = readFileSync(join(dir, 'vk-job-shadow.json'), 'utf8')
    expect(raw).not.toContain('example.com')
    expect(raw).not.toContain('xsec_token')
    expect(raw).not.toContain('leak-me')
    expect(raw).not.toContain('job-1') // vk job id 是进程内关联键，不落盘
    const entries = JSON.parse(raw).entries
    expect(entries).toHaveLength(1)
    expect(Object.keys(entries[0]).sort()).toEqual([...SHADOW_FIELDS].sort())
    expect(entries[0]).toMatchObject({
      clientJobId: 'client-1',
      idempotencyKey: 'idem-1',
      requestFingerprint: 'f'.repeat(64),
      runId: 'run-9',
      displayStatus: 'done',
    })
  })

  it('reloads persisted entries and keeps working in memory-only mode', () => {
    const dir = tempDir()
    const file = join(dir, 'shadow.json')
    const first = createVkJobShadow({ stateFile: file })
    first.recordSubmit({ vkJobId: 'j1', clientJobId: 'c1', idempotencyKey: 'k1' })
    first.observeView({ job_id: 'j1', status: 'running', run_id: 'r1' })

    const second = createVkJobShadow({ stateFile: file })
    expect(second.list()).toHaveLength(1)
    expect(second.list()[0].runId).toBe('r1')

    const memoryOnly = createVkJobShadow({})
    memoryOnly.recordSubmit({ vkJobId: 'j2', clientJobId: 'c2' })
    expect(memoryOnly.list()).toHaveLength(1)
  })

  it('bounds the persisted history', () => {
    const shadow = createVkJobShadow({ maxEntries: 3 })
    for (let index = 0; index < 5; index += 1) {
      shadow.recordSubmit({ vkJobId: `j${index}`, clientJobId: `c${index}` })
    }
    expect(shadow.list()).toHaveLength(3)
    expect(shadow.list()[0].clientJobId).toBe('c4') // 最新在前
  })

  it('ignores malformed persisted content instead of crashing', () => {
    const dir = tempDir()
    const file = join(dir, 'shadow.json')
    const shadow = createVkJobShadow({ stateFile: file })
    shadow.recordSubmit({ vkJobId: 'j1', clientJobId: 'c1' })
    // 手写坏文件再加载
    writeFileSync(file, '{not json', 'utf8')
    const reloaded = createVkJobShadow({ stateFile: file })
    expect(reloaded.list()).toEqual([])
  })
})
