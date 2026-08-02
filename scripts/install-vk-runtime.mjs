// CLI 壳:安装核心在随包发货的 server/vk-runtime-install.mjs。
// v2 阶段3 起:uv 必须显式给出(--uv 或 bundle manifest),不再依赖 PATH;
// wheel/uv 先过 manifest SHA-256 核验,不匹配拒绝激活。
//
// 用法:
//   node scripts/install-vk-runtime.mjs --bundle <dir> --home <dir> [--version v] [--extra media-asr]
//   node scripts/install-vk-runtime.mjs --wheel <whl> --uv <uv.exe> --manifest <json> --home <dir> ...
import { installVkRuntime, VkRuntimeInstallError } from '../server/vk-runtime-install.mjs'

function parseArgs(argv) {
  const args = { extras: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--wheel') args.wheelPath = argv[++i]
    else if (key === '--uv') args.uvPath = argv[++i]
    else if (key === '--manifest') args.manifestPath = argv[++i]
    else if (key === '--bundle') args.bundleDir = argv[++i]
    else if (key === '--home') args.home = argv[++i]
    else if (key === '--version') args.version = argv[++i]
    else if (key === '--python') args.python = argv[++i]
    else if (key === '--extra') args.extras.push(argv[++i])
    else throw new Error(`unknown argument: ${key}`)
  }
  if (!args.home) throw new Error('--home is required')
  if (!args.bundleDir && !(args.uvPath && args.manifestPath)) {
    throw new Error('显式给出 --bundle <dir>,或同时给出 --uv 与 --manifest(不依赖 PATH)')
  }
  return args
}

try {
  const args = parseArgs(process.argv.slice(2))
  const result = await installVkRuntime({
    ...args,
    log: (line) => console.log(`[vk-runtime] ${line}`),
  })
  console.log(JSON.stringify({ vkRuntimeInstalled: true, ...result }))
} catch (error) {
  const reason = error instanceof VkRuntimeInstallError ? error.reasonCode : 'install-failed'
  console.error(`[vk-runtime] FAIL ${reason}: ${error.message}`)
  if (error?.detail) console.error(String(error.detail).slice(0, 800))
  console.error('[vk-runtime] 旧 runtime 与旧 DB 未被触碰,继续可用。')
  process.exit(1)
}
