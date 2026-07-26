// dist-host 里"来自仓内源码"的那部分,由 build 与 verify **共用同一份定义**。
//
// 为什么要抽出来:闭包硬闸原本只拿 dist-host 对**它自己的清单**比,证明的是"生成之后没被篡改",
// 证明不了"它跟仓内源码是同一版" —— 对着一份陈旧的 dist-host 裸跑,8/8 照样全绿。
// 发布路径本身是安全的(`beforeBuildCommand` 会重跑 build:host),但**闸门是我们据以推理的东西**,
// 它能陈旧地绿就是下一个坑。
//
// 而如果 build 和 verify 各写一份"拷哪些文件"的过滤规则,规则一改就会让新增的校验悄悄失效——
// 那等于用一个假绿换掉另一个假绿。所以这里是唯一定义:build 照它拷,verify 照它查。
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** `from` 相对仓根;`to` 是它在 dist-host 里的镜像位置(拓扑必须一致,server 用相对 import)。 */
export const HOST_SOURCE_SETS = [
  { from: 'server', to: 'server', skip: (rel) => rel.endsWith('.test.mjs') },
  { from: 'src/shared', to: 'src/shared', skip: (rel) => rel.includes('.test.') },
  { from: 'public/catalog.snapshot.json', to: 'public/catalog.snapshot.json' },
]

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}

/**
 * 列出所有"要进 dist-host 的仓内源码"。
 * @returns {Array<{ source: string, mirrored: string }>} source=绝对路径,mirrored=dist-host 内相对路径
 */
export function listHostSourceFiles(root) {
  const out = []
  for (const set of HOST_SOURCE_SETS) {
    const from = resolve(root, set.from)
    if (statSync(from).isFile()) {
      out.push({ source: from, mirrored: set.to })
      continue
    }
    for (const p of walk(from)) {
      const rel = relative(from, p).replace(/\\/g, '/')
      if (set.skip?.(rel)) continue
      out.push({ source: p, mirrored: `${set.to}/${rel}` })
    }
  }
  return out.sort((a, b) => a.mirrored.localeCompare(b.mirrored))
}
