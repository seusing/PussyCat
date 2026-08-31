// @vitest-environment node
//
// 底座 / 应用层拆分。
//
// 自包含布局把 2.4 GB 依赖和 493 KB 应用码绑成一个不可变单元:应用码一变就要重建整个
// 目录(硬链接克隆 41,646 个文件,实测 22~60 秒)。两者变化频率差几个数量级,绑在一起
// 是设计上的错配。拆开之后依赖按环境指纹共享,每次更新真正变的只有那 493 KB。
//
// 这里钉四件事:
//   1. 底座复用 —— 第二次装同一套依赖时,克隆与建 venv 一次都不许发生(省下来的就是它)
//   2. 校验边界 —— 拆层后"解释器就在版本目录下"这条不成立了,新的三条约束必须真的挡事
//   3. 向后兼容 —— 老的自包含 runtime 不作废,它可能是用户唯一能跑的那一个
//   4. 应用层要到得了运行时 —— active.json 带 appPath,否则 sidecar 拿着空底座启动
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installVkRuntime, sha256File } from './vk-runtime-install.mjs'
import {
  pruneUnreferencedBases, removeOwnedRuntimeReceipt, resolveActiveRuntime,
  writeActiveRuntime, writeRuntimeReceipt,
} from './vk-runtime-resolver.mjs'

const dirs = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

/** wheelBytes 不同 → wheelSha256 不同 → 版本标签不同,但环境指纹不变(依赖没动)。 */
function makeBundle(wheelBytes = 'wheel-bytes') {
  const bundle = tempDir('vk-bundle-')
  const wheel = join(bundle, 'video_knowledge-0.1.0-py3-none-any.whl')
  const uv = join(bundle, 'uv.exe')
  writeFileSync(wheel, wheelBytes)
  writeFileSync(uv, 'uv-bytes')
  const requirements = join(bundle, 'requirements-base.txt')
  writeFileSync(requirements, 'requests==2.0 --hash=sha256:fixture\n')
  writeFileSync(join(bundle, 'runtime-manifest.json'), JSON.stringify({
    schema: 'vk-runtime-bundle@2',
    source: { pythonLockSha256: 'c'.repeat(64) },
    wheel: { name: 'video_knowledge-0.1.0-py3-none-any.whl', sha256: sha256File(wheel) },
    uv: { name: 'uv.exe', sha256: sha256File(uv) },
    runtime: {
      contractSchema: 'vk-runtime-contract@1',
      pythonImplementation: 'cpython', pythonVersion: '3.12',
      pythonAbi: 'cp312', platform: 'x86_64-pc-windows-msvc',
      requirements: [{
        key: 'base', extras: [], name: 'requirements-base.txt',
        sha256: sha256File(requirements),
      }],
      modelPacks: [],
    },
  }))
  return bundle
}

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
  }

  kill() { return true }
}

function makeSpawn(calls) {
  return (_program, argv) => {
    calls.push(argv)
    const child = new FakeChild()
    queueMicrotask(() => {
      const joined = argv.join(' ')
      if (joined.includes('--target')) {
        const target = argv[argv.indexOf('--target') + 1]
        mkdirSync(join(target, 'video_knowledge'), { recursive: true })
        writeFileSync(join(target, 'video_knowledge', '__init__.py'), '')
        child.emit('close', 0)
        return
      }
      if (argv[0] === 'venv') {
        const dir = argv[argv.length - 1]
        mkdirSync(join(dir, 'Scripts'), { recursive: true })
        writeFileSync(join(dir, 'Scripts', 'python.exe'), 'py')
        child.emit('close', 0)
        return
      }
      if (argv.includes('gui')) {
        child.stdout.write('gui=http://127.0.0.1:45678\n')
        return
      }
      if (joined.includes('pip check')) child.stdout.write('Checked 153 packages\n')
      if (argv.includes('video_knowledge.runtime_ocr_models')) {
        child.stdout.write(`VK_OCR_MODEL_RESULT=${JSON.stringify({ ready: true, reused: true, files: [] })}\n`)
      }
      if (joined.includes('migrate')) child.stdout.write('["008"]\n')
      if (joined.includes('importlib.metadata')) child.stdout.write('[]\n')
      child.emit('close', 0)
    })
    return child
  }
}

function install({ home, bundle, calls = [] }) {
  return installVkRuntime({
    home, bundleDir: bundle, spawnImpl: makeSpawn(calls),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      service: 'video-knowledge', shell_mode: true, api_version: '1.4.0',
      processing_request_schema_version: '1.1.0', capabilities: [],
    }) }),
  })
}

describe('底座 / 应用层拆分', () => {
  it('依赖没变时第二次安装复用底座 —— 不建 venv、不克隆、只装那 493 KB', async () => {
    // 这条就是整个改动要买的东西。它一旦不成立,拆分就只剩复杂度没有收益。
    const home = tempDir('vk-home-')
    const first = []
    await install({ home, bundle: makeBundle('wheel-v1'), calls: first })
    expect(first.some((argv) => argv[0] === 'venv')).toBe(true)

    const second = []
    const result = await install({ home, bundle: makeBundle('wheel-v2'), calls: second })

    expect(second.some((argv) => argv[0] === 'venv')).toBe(false)
    expect(second.some((argv) => argv.join(' ').includes('--require-hashes'))).toBe(false)
    expect(second.some((argv) => argv.join(' ').includes('--target'))).toBe(true)
    expect(result.stepTimings.map((item) => item.step)).toContain('reuse-base')
  })

  it('有环境指纹一致的老 runtime 时,底座从它硬链接过来而不是重装', async () => {
    // 这条走的是**真实** hardlinkCloneDir + 真实文件系统,不是 fake spawn —— 因为
    // 出过的问题正在那里:hardlinkCloneDir 逐层建目录、不能用 recursive,而第一次
    // 拆层安装时 runtime/bases 还不存在,克隆以 ENOENT 失败后被 catch 静默吞掉、
    // 回落全量安装。单测全绿(fake 的 venv 是 recursive 建目录的),真机上过渡成本
    // 从 20 秒变成 230 秒,而且没有任何报错。
    const home = tempDir('vk-home-')
    const bundle = makeBundle()

    // 先造一个自包含的老 runtime 当供体:环境指纹取安装器算出来的那一个
    const probe = []
    await install({ home, bundle, calls: probe })
    const receipt = JSON.parse(readFileSync(
      join(home, 'runtime', 'bases', readdirSync(join(home, 'runtime', 'bases'))[0], 'base-receipt.json'),
      'utf8',
    ))
    const donorDir = join(home, 'runtime', 'versions', 'legacy-donor')
    mkdirSync(join(donorDir, 'Scripts'), { recursive: true })
    writeFileSync(join(donorDir, 'Scripts', 'python.exe'), 'py')
    mkdirSync(join(donorDir, 'Lib', 'site-packages', 'deep', 'nested'), { recursive: true })
    writeFileSync(join(donorDir, 'Lib', 'site-packages', 'deep', 'nested', 'payload.bin'), 'x')
    writeFileSync(join(donorDir, 'runtime-receipt.json'), JSON.stringify({
      schema: 'vk-runtime-receipt@2', source: 'app-owned',
      environmentFingerprint: receipt.environmentFingerprint,
    }))
    // 清掉底座,逼下一次安装重建 —— 此时应当走克隆而不是重装
    rmSync(join(home, 'runtime', 'bases'), { recursive: true, force: true })

    const calls = []
    const result = await install({ home, bundle, calls })
    const steps = result.stepTimings.map((item) => item.step)

    expect(steps).toContain('base-clone')
    expect(steps).toContain('base-strip-app')
    expect(steps).not.toContain('base-install-locked')
    // 克隆是真做了的:供体深处那个文件必须出现在底座里
    const baseName = readdirSync(join(home, 'runtime', 'bases'))[0]
    expect(existsSync(join(
      home, 'runtime', 'bases', baseName, 'Lib', 'site-packages', 'deep', 'nested', 'payload.bin',
    ))).toBe(true)
  })

  it('两次安装共用同一个底座目录,版本目录各自独立', async () => {
    const home = tempDir('vk-home-')
    const a = await install({ home, bundle: makeBundle('wheel-v1') })
    const b = await install({ home, bundle: makeBundle('wheel-v2') })

    const receiptA = JSON.parse(readFileSync(join(home, 'runtime', 'versions', a.version, 'runtime-receipt.json'), 'utf8'))
    const receiptB = JSON.parse(readFileSync(join(home, 'runtime', 'versions', b.version, 'runtime-receipt.json'), 'utf8'))

    expect(a.version).not.toBe(b.version)
    expect(receiptA.basePath).toBe(receiptB.basePath)      // 依赖共享
    expect(receiptA.appPath).not.toBe(receiptB.appPath)    // 应用层各自一份
    expect(receiptA.runtimeLayout).toBe('split')
  })

  it('底座建好后写下 receipt,并记着"里面没有我们的包"', async () => {
    // 底座留着旧版 video_knowledge 的话,一旦哪个 spawn 点漏传 PYTHONPATH,跑的就是
    // 旧代码而且一声不吭。所以这是承重条件,安装期当场验、receipt 上记着。
    const home = tempDir('vk-home-')
    const calls = []
    await install({ home, bundle: makeBundle(), calls })

    expect(calls.some((argv) => argv.join(' ').includes('find_spec("video_knowledge")'))).toBe(true)
    const bases = join(home, 'runtime', 'bases')
    const [baseName] = readdirSync(bases)
    const baseReceipt = JSON.parse(readFileSync(join(bases, baseName, 'base-receipt.json'), 'utf8'))
    expect(baseReceipt.schema).toBe('vk-runtime-base@1')
    expect(baseReceipt.appFree).toBe(true)
  })

  it('active.json 带上 appPath —— 少了它 sidecar 会拿着空底座启动', async () => {
    const home = tempDir('vk-home-')
    const result = await install({ home, bundle: makeBundle() })

    const active = JSON.parse(readFileSync(join(home, 'runtime', 'active.json'), 'utf8'))
    expect(active.runtimeLayout).toBe('split')
    expect(active.appPath).toBe(join(home, 'runtime', 'versions', result.version, 'app'))
    // 解释器指向共享底座,不在版本目录里
    expect(active.pythonPath.includes(join('runtime', 'bases'))).toBe(true)
  })

  it('装完立刻能被解析器认出来 —— 写入端与校验端必须对得上', async () => {
    const home = tempDir('vk-home-')
    const installed = await install({ home, bundle: makeBundle() })

    const active = resolveActiveRuntime({ home })
    expect(active).not.toBeNull()
    expect(String(active.version)).toBe(installed.version)
    expect(active.runtimeLayout).toBe('split')
  })

  it('应用层被删掉的 receipt 判无效 —— 那是个跑不起来的 runtime', async () => {
    // 自包含布局靠"解释器就在版本目录下"把 receipt 和它描述的环境锁在一起。拆层后
    // 这条不成立,得显式验应用层还在;否则一份 receipt 能给一个空壳背书。
    const home = tempDir('vk-home-')
    const installed = await install({ home, bundle: makeBundle() })
    rmSync(join(home, 'runtime', 'versions', installed.version, 'app'), { recursive: true, force: true })

    expect(resolveActiveRuntime({ home, repair: false })).toBeNull()
  })

  it('appPath 被改指到别处的 receipt 判无效', async () => {
    const home = tempDir('vk-home-')
    const installed = await install({ home, bundle: makeBundle() })
    const receiptPath = join(home, 'runtime', 'versions', installed.version, 'runtime-receipt.json')
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    const elsewhere = tempDir('vk-elsewhere-')
    mkdirSync(join(elsewhere, 'video_knowledge'), { recursive: true })
    writeFileSync(join(elsewhere, 'video_knowledge', '__init__.py'), '')
    receipt.appPath = elsewhere
    writeFileSync(receiptPath, JSON.stringify(receipt))

    expect(resolveActiveRuntime({ home, repair: false })).toBeNull()
  })

  it('basePath 指到 runtime/bases 之外的 receipt 判无效', async () => {
    const home = tempDir('vk-home-')
    const installed = await install({ home, bundle: makeBundle() })
    const receiptPath = join(home, 'runtime', 'versions', installed.version, 'runtime-receipt.json')
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    receipt.basePath = tempDir('vk-rogue-base-')
    writeFileSync(receiptPath, JSON.stringify(receipt))

    expect(resolveActiveRuntime({ home, repair: false })).toBeNull()
  })

  it('清理旧版本时不会被"底座解释器相同"误判成正在用', async () => {
    // 自包含布局里 pythonPath 唯一标识一个 runtime,所以"active 的 pythonPath 等于
    // 待删的"是一条有效的保护。拆层之后**所有版本共用同一个底座解释器**,那条判据
    // 会把每一个版本都判成正在用 —— 清理全线拒绝,一个都删不掉。
    const home = tempDir('vk-home-')
    const older = await install({ home, bundle: makeBundle('wheel-v1') })
    const newer = await install({ home, bundle: makeBundle('wheel-v2') })
    const olderReceipt = JSON.parse(readFileSync(
      join(home, 'runtime', 'versions', older.version, 'runtime-receipt.json'), 'utf8',
    ))
    const active = JSON.parse(readFileSync(join(home, 'runtime', 'active.json'), 'utf8'))

    expect(active.pythonPath).toBe(olderReceipt.pythonPath)   // 同一个底座解释器
    expect(String(active.version)).toBe(newer.version)        // 但活动的是新版本

    const removed = removeOwnedRuntimeReceipt({
      home,
      runtime: {
        ...olderReceipt,
        receiptPath: join(home, 'runtime', 'versions', older.version, 'runtime-receipt.json'),
      },
    })

    expect(removed.version).toBe(older.version)
    expect(existsSync(join(home, 'runtime', 'versions', older.version))).toBe(false)
    expect(existsSync(join(home, 'runtime', 'versions', newer.version))).toBe(true)
  })

  it('活动版本本身仍然删不掉', async () => {
    const home = tempDir('vk-home-')
    const installed = await install({ home, bundle: makeBundle() })
    const receipt = JSON.parse(readFileSync(
      join(home, 'runtime', 'versions', installed.version, 'runtime-receipt.json'), 'utf8',
    ))

    expect(() => removeOwnedRuntimeReceipt({
      home,
      runtime: {
        ...receipt,
        receiptPath: join(home, 'runtime', 'versions', installed.version, 'runtime-receipt.json'),
      },
    })).toThrow(/活动 runtime/)
  })

  it('依赖变了会新建底座,旧底座在无人引用后被回收', async () => {
    // 底座共享之后,删版本目录不再释放依赖 —— 不回收就是我们自己引入的泄漏。
    const home = tempDir('vk-home-')
    const first = await install({ home, bundle: makeBundle('wheel-v1') })
    const firstBase = JSON.parse(readFileSync(
      join(home, 'runtime', 'versions', first.version, 'runtime-receipt.json'), 'utf8',
    )).basePath
    expect(existsSync(firstBase)).toBe(true)

    // 换一份依赖清单 → 环境指纹变 → 新底座
    const bundle = makeBundle('wheel-v2')
    writeFileSync(join(bundle, 'requirements-base.txt'), 'requests==3.0 --hash=sha256:other\n')
    const manifestPath = join(bundle, 'runtime-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.runtime.requirements[0].sha256 = sha256File(join(bundle, 'requirements-base.txt'))
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const second = await install({ home, bundle })
    const secondBase = JSON.parse(readFileSync(
      join(home, 'runtime', 'versions', second.version, 'runtime-receipt.json'), 'utf8',
    )).basePath

    expect(secondBase).not.toBe(firstBase)
    // 第一个版本还在,它的 receipt 仍然引用旧底座 —— 所以旧底座**不该**被回收
    expect(existsSync(firstBase)).toBe(true)

    // 把第一个版本目录删掉,旧底座就没人引用了
    rmSync(join(home, 'runtime', 'versions', first.version), { recursive: true, force: true })
    const removed = pruneUnreferencedBases({ home })

    expect(removed.length).toBe(1)
    expect(existsSync(firstBase)).toBe(false)
    expect(existsSync(secondBase)).toBe(true)      // 正在用的那个一根汗毛都不能动
  })

  it('回收永远不碰 active.json 指着的底座', async () => {
    const home = tempDir('vk-home-')
    const installed = await install({ home, bundle: makeBundle() })
    const base = JSON.parse(readFileSync(
      join(home, 'runtime', 'versions', installed.version, 'runtime-receipt.json'), 'utf8',
    )).basePath
    // 版本目录整个没了(receipt 也就无从校验),但 active.json 还指着这个底座
    rmSync(join(home, 'runtime', 'versions', installed.version), { recursive: true, force: true })

    expect(pruneUnreferencedBases({ home })).toEqual([])
    expect(existsSync(base)).toBe(true)
  })

  it('老的自包含 runtime 照常解析 —— 它可能是用户唯一能跑的那一个', () => {
    // 拆层是新装的形态,已经在盘上的自包含 runtime 一个字段都没变,必须继续有效。
    // 把它们判无效等于让用户的引擎在一次更新后凭空消失。
    const home = tempDir('vk-home-')
    const version = 'video_knowledge-0.1.0-py3-none-any+runtime-legacy000000'
    const versionDir = join(home, 'runtime', 'versions', version)
    const pythonPath = join(versionDir, 'Scripts', 'python.exe')
    mkdirSync(join(versionDir, 'Scripts'), { recursive: true })
    writeFileSync(pythonPath, 'py')
    const receipt = writeRuntimeReceipt(home, {
      schema: 'vk-runtime-receipt@1', source: 'app-owned', version, pythonPath,
      wheelSha256: 'a'.repeat(64), apiVersion: '1.4.0', schemaVersion: '1.1.0',
      capabilities: [], extras: [], installedAt: new Date().toISOString(),
    })
    writeActiveRuntime(home, receipt)

    const active = resolveActiveRuntime({ home })
    expect(active).not.toBeNull()
    expect(String(active.version)).toBe(version)
    expect(active.runtimeLayout).toBeUndefined()   // 老形态不带这个字段,也不该被塞上
    expect(active.appPath).toBeUndefined()          // 老形态的包就在解释器自己的 site-packages 里
  })

  it('删掉一个版本只释放它自己那几 MB,共享底座留着', async () => {
    // 体积报的必须是"删它真正释放的字节"。把 2.4 GB 记到每个 2 MB 的版本头上,
    // 清理界面就会承诺一个兑现不了的数字。
    const home = tempDir('vk-home-')
    await install({ home, bundle: makeBundle('wheel-v1') })
    const b = await install({ home, bundle: makeBundle('wheel-v2') })
    const receipt = JSON.parse(readFileSync(join(home, 'runtime', 'versions', b.version, 'runtime-receipt.json'), 'utf8'))

    expect(receipt.runtimeSizeBytes).toBeLessThan(1_000_000)
    expect(existsSync(receipt.basePath)).toBe(true)
  })
})
