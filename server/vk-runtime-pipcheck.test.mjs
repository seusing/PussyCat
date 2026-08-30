// @vitest-environment node
//
// pip-check 对 onnxruntime-directml 的放行。
//
// 背景:Windows 上装的是 onnxruntime-directml(走 GPU),它提供的正是 `onnxruntime`
// 这个导入包,但发行版名字不同。`uv pip check` 只比对发行版名,于是把 faster-whisper
// 声明的 `onnxruntime>=1.14,<2` 判成「未安装」——一个功能完全正常的环境被判不兼容,
// 安装中止、从未激活,用户那边表现为「解析引擎有更新」点几次都不消失。
//
// 放行必须是**窄**的:只认这一种替换,且要用真的 import 通过来证明,其余任何不兼容
// 照旧中止。这三条就是那道边界。
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installVkRuntime, sha256File } from './vk-runtime-install.mjs'

const dirs = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

function makeBundle() {
  const bundle = tempDir('vk-bundle-')
  const wheel = join(bundle, 'video_knowledge-0.1.0-py3-none-any.whl')
  const uv = join(bundle, 'uv.exe')
  writeFileSync(wheel, 'wheel-bytes')
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

/** pipCheckStderr 非空即让 pip-check 以 exit 1 失败并吐出该文本。 */
function runInstall({ pipCheckStderr, importOnnxruntimeOk = true, calls = [] }) {
  const bundle = makeBundle()
  const home = tempDir('vk-home-')
  const spawnImpl = (_program, argv) => {
    calls.push(argv)
    const child = new FakeChild()
    queueMicrotask(() => {
      const joined = argv.join(' ')
      if (argv.includes('gui')) {
        child.stdout.write('gui=http://127.0.0.1:45678\n')
        return
      }
      if (joined.includes('pip check')) {
        if (pipCheckStderr) {
          child.stderr.write(pipCheckStderr)
          child.emit('close', 1)
          return
        }
        child.stdout.write('Checked 153 packages\n')
        child.emit('close', 0)
        return
      }
      if (joined.includes('import onnxruntime')) {
        if (!importOnnxruntimeOk) {
          child.stderr.write("ModuleNotFoundError: No module named 'onnxruntime'\n")
          child.emit('close', 1)
          return
        }
        child.stdout.write('1.24.4\n')
        child.emit('close', 0)
        return
      }
      if (argv.includes('video_knowledge.runtime_ocr_models')) {
        child.stdout.write(`VK_OCR_MODEL_RESULT=${JSON.stringify({ ready: true, reused: true, files: [] })}\n`)
      }
      if (joined.includes('migrate')) child.stdout.write('["008"]\n')
      if (joined.includes('importlib.metadata')) child.stdout.write('[]\n')
      child.emit('close', 0)
    })
    return child
  }
  return {
    home,
    promise: installVkRuntime({
      home, bundleDir: bundle, spawnImpl,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        service: 'video-knowledge', shell_mode: true, api_version: '1.4.0',
        processing_request_schema_version: '1.1.0', capabilities: [],
      }) }),
    }),
  }
}

const ONNXRUNTIME_ONLY =
  'Found 1 incompatibility\n'
  + 'The package `faster-whisper` requires `onnxruntime>=1.14,<2`, but it\'s not installed\n'

describe('pip-check 对 onnxruntime-directml 的放行', () => {
  it('只差 onnxruntime 且 import 通过时放行,安装照常激活', async () => {
    const calls = []
    const { home, promise } = runInstall({ pipCheckStderr: ONNXRUNTIME_ONLY, calls })
    await promise
    expect(existsSync(join(home, 'runtime', 'active.json'))).toBe(true)
    // 放行的依据必须是真的 import 过一次,不是看名字放过去
    expect(calls.some((argv) => argv.join(' ').includes('import onnxruntime'))).toBe(true)
  })

  it('import 也失败时不放行 —— 那是真坏了', async () => {
    const { home, promise } = runInstall({
      pipCheckStderr: ONNXRUNTIME_ONLY, importOnnxruntimeOk: false,
    })
    await expect(promise).rejects.toBeTruthy()
    expect(existsSync(join(home, 'runtime', 'active.json'))).toBe(false)
  })

  it('掺了别的不兼容就照旧中止 —— 放行必须是窄的', async () => {
    const { home, promise } = runInstall({
      pipCheckStderr: ONNXRUNTIME_ONLY
        + "The package `torch` requires `numpy>=1.21`, but it's not installed\n",
    })
    await expect(promise).rejects.toMatchObject({ reasonCode: 'pip-check-failed' })
    expect(existsSync(join(home, 'runtime', 'active.json'))).toBe(false)
  })
})
