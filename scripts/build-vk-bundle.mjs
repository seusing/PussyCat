// 构建期把固定 SHA 的 VK wheel + 固定版本 uv.exe + runtime-manifest.json
// 放进 Tauri resources(v2 阶段3)。manifest 记录版本/文件名/SHA-256,
// 安装端先实算 digest 再决定是否激活。
//
// 默认路径可用 env 覆盖:VK_WHEEL_PATH / VK_UV_PATH。
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const wheelPath = process.env.VK_WHEEL_PATH
  ?? 'C:\\Users\\Lauseusing\\Developer\\video-knowledge-m1-productization\\dist\\video_knowledge-0.1.0-py3-none-any.whl'
const uvPath = process.env.VK_UV_PATH ?? 'C:\\Users\\Lauseusing\\.local\\bin\\uv.exe'
const outDir = join(projectRoot, 'src-tauri', 'resources', 'vk')

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const uvVersion = spawnSync(uvPath, ['--version'], { shell: false, windowsHide: true, encoding: 'utf8' })
if (uvVersion.status !== 0) {
  console.error(`[vk-bundle] uv 不可用: ${uvPath}`)
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
copyFileSync(wheelPath, join(outDir, basename(wheelPath)))
copyFileSync(uvPath, join(outDir, 'uv.exe'))

const manifest = {
  schema: 'vk-runtime-bundle@1',
  generatedAt: new Date().toISOString(),
  wheel: {
    name: basename(wheelPath),
    version: (/-([\d.]+)-py3/.exec(basename(wheelPath)) ?? [null, 'unknown'])[1],
    sha256: sha256(join(outDir, basename(wheelPath))),
  },
  uv: {
    name: 'uv.exe',
    version: uvVersion.stdout.trim(),
    sha256: sha256(join(outDir, 'uv.exe')),
  },
}
writeFileSync(join(outDir, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`[vk-bundle] ${manifest.wheel.name} ${manifest.wheel.sha256.slice(0, 12)}… + ${manifest.uv.version} -> ${outDir}`)
