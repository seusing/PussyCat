// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOpencliRuntime, versionEntry } from './opencli-runtime.mjs'

const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'opencli-runtime-'))
  dirs.push(dir)
  return dir
}

// 在 base 下造一个假的 OpenCLI 包(入口 + package.json),返回入口路径。
function fakePackage(base, version) {
  const packageRoot = join(base, 'node_modules', '@jackwener', 'opencli')
  mkdirSync(join(packageRoot, 'dist', 'src'), { recursive: true })
  writeFileSync(join(packageRoot, 'dist', 'src', 'main.js'), '')
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version }))
  return join(packageRoot, 'dist', 'src', 'main.js')
}

function setup() {
  const base = tempDir()
  const dataRoot = join(base, 'data')
  const bundledEntry = fakePackage(join(base, 'bundled'), '1.8.8')
  const runtime = createOpencliRuntime({ bundledEntry, dataRoot })
  return { base, dataRoot, bundledEntry, runtime }
}

describe('opencli runtime', () => {
  it('没有更新过:用内置入口和内置版本', () => {
    const { runtime, bundledEntry, dataRoot } = setup()
    expect(runtime.entry()).toBe(bundledEntry)
    expect(runtime.version()).toBe('1.8.8')
    expect(runtime.bundledVersion()).toBe('1.8.8')
    expect(runtime.active()).toBeNull()
    expect(runtime.root).toBe(join(dataRoot, 'opencli'))
  })

  it('activate 之后 entry/version 指向新版本,内置版本不变', () => {
    const { runtime, dataRoot } = setup()
    const entry = fakePackage(join(dataRoot, 'opencli', 'versions', '2.0.2'), '2.0.2')
    runtime.activate('2.0.2', entry)
    expect(runtime.entry()).toBe(entry)
    expect(runtime.version()).toBe('2.0.2')
    expect(runtime.bundledVersion()).toBe('1.8.8')
    expect(runtime.active()).toEqual({ version: '2.0.2', entry })
  })

  it('active.json 记录 version、entry、installedAt,且是原子写入(不留临时文件)', () => {
    const { runtime, dataRoot } = setup()
    const entry = fakePackage(join(dataRoot, 'opencli', 'versions', '2.0.2'), '2.0.2')
    runtime.activate('2.0.2', entry)
    const written = JSON.parse(readFileSync(join(dataRoot, 'opencli', 'active.json'), 'utf8'))
    expect(written).toEqual({ version: '2.0.2', entry, installedAt: expect.any(Number) })
    expect(readdirSync(join(dataRoot, 'opencli')).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('新创建的 runtime(重启后)读到同一份 active.json', () => {
    const { runtime, dataRoot, bundledEntry } = setup()
    const entry = fakePackage(join(dataRoot, 'opencli', 'versions', '2.0.2'), '2.0.2')
    runtime.activate('2.0.2', entry)
    expect(createOpencliRuntime({ bundledEntry, dataRoot }).entry()).toBe(entry)
  })

  it('rollback 删掉 active.json,退回内置', () => {
    const { runtime, dataRoot, bundledEntry } = setup()
    runtime.activate('2.0.2', fakePackage(join(dataRoot, 'opencli', 'versions', '2.0.2'), '2.0.2'))
    runtime.rollback()
    expect(runtime.entry()).toBe(bundledEntry)
    expect(runtime.version()).toBe('1.8.8')
    expect(() => runtime.rollback()).not.toThrow()
  })

  it.each([
    ['损坏的 JSON', () => '{oops'],
    ['缺 entry', () => JSON.stringify({ version: '2.0.2' })],
    ['入口文件不存在', (dataRoot) => JSON.stringify({ version: '2.0.2', entry: join(dataRoot, 'opencli', 'versions', '2.0.2', 'dist', 'src', 'main.js') })],
  ])('启动时 active.json 无效(%s):退回内置', (_name, content) => {
    const { runtime, dataRoot, bundledEntry } = setup()
    mkdirSync(join(dataRoot, 'opencli'), { recursive: true })
    writeFileSync(join(dataRoot, 'opencli', 'active.json'), content(dataRoot))
    expect(runtime.entry()).toBe(bundledEntry)
    expect(runtime.version()).toBe('1.8.8')
    expect(runtime.active()).toBeNull()
  })

  it('入口路径不是 …/dist/src/main.js 就不采用,也拒绝 activate', () => {
    const { runtime, dataRoot, bundledEntry } = setup()
    const wrong = join(dataRoot, 'opencli', 'versions', '2.0.2', 'other.js')
    mkdirSync(join(dataRoot, 'opencli', 'versions', '2.0.2'), { recursive: true })
    writeFileSync(wrong, '')
    expect(() => runtime.activate('2.0.2', wrong)).toThrow('Unexpected OpenCLI entry')
    writeFileSync(join(dataRoot, 'opencli', 'active.json'), JSON.stringify({ version: '2.0.2', entry: wrong }))
    expect(runtime.entry()).toBe(bundledEntry)
  })

  it('生效入口在运行中被删掉:退回内置,不抛', () => {
    const { runtime, dataRoot, bundledEntry } = setup()
    const base = join(dataRoot, 'opencli', 'versions', '2.0.2')
    runtime.activate('2.0.2', fakePackage(base, '2.0.2'))
    rmSync(base, { recursive: true, force: true })
    expect(runtime.entry()).toBe(bundledEntry)
  })

  it('versionEntry 给出版本目录下的入口路径', () => {
    expect(versionEntry('/r', '2.0.2')).toBe(join('/r', 'versions', '2.0.2', 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js'))
  })
})
