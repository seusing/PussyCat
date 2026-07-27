// CI 闸:legacy 只减不增(L1)。新增 key 直接失败;删除允许。
//
// base ref 可用 LEGACY_BASE_REF 覆盖(默认 origin/main),三个理由:
//   1. **本闸门的失败路径必须可验证**。首次引入时 origin/main 上还没有这个文件,
//      比较分支根本走不到——若不可覆盖,交付时唯一被执行过的是「跳过」分支,
//      真正防守 L1 的 added-detection 逻辑零验证。见 Step 7。
//   2. CI 上 PR 应比 merge-base,而不是随时间漂移的 origin/main。
//   3. 浅克隆里 origin/main 往往不存在。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const path = 'server/policy-legacy-baseline.json'
const baseRef = process.env.LEGACY_BASE_REF || 'origin/main'
const current = JSON.parse(readFileSync(resolve(root, path), 'utf8'))

// 「ref 不存在」与「ref 上没有该文件」是两回事,不能都静默放行:
// 前者是环境问题(没 fetch / 浅克隆),静默 exit 0 会让闸门在 CI 里永远绿着而没人发现。
try {
  execFileSync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: root, stdio: 'pipe' })
} catch {
  console.error(`[legacy] ❌ base ref '${baseRef}' 不存在,无法比较。`)
  console.error('[legacy] 请先 git fetch,或用 LEGACY_BASE_REF 指定一个存在的 ref。')
  console.error('[legacy] 闸门 fail-closed:宁可报错,不静默放行。')
  process.exit(1)
}

// 取文件与解析文件必须分开 catch:`git show` 失败 = 该 ref 上没有这个文件(合法的首次引入);
// JSON.parse 失败 = 文件在那儿但坏了。后者若复用「尚无基线」的话术并 exit 0,
// 输出是**事实错误**(基线明明存在,只是损坏),而且闸门会对一份坏基线放行——
// 与上面「宁可报错,不静默放行」自相矛盾。
let baseRaw
try {
  baseRaw = execFileSync('git', ['show', `${baseRef}:${path}`], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
} catch {
  console.log(`[legacy] '${baseRef}' 上尚无基线,跳过 diff 检查(首次引入)`)
  process.exit(0)
}

let base
try {
  base = JSON.parse(baseRaw)
} catch (err) {
  console.error(`[legacy] ❌ base ref '${baseRef}' 上的基线文件解析失败:${err.message}`)
  console.error('[legacy] 文件存在但不可解析,视为错误而非「首次引入」。闸门 fail-closed。')
  process.exit(1)
}

const added = Object.keys(current.entries).filter((k) => !(k in base.entries))
const removed = Object.keys(base.entries).filter((k) => !(k in current.entries))
console.log(`[legacy] legacyCount ${Object.keys(base.entries).length} → ${Object.keys(current.entries).length}`)
if (removed.length) console.log(`[legacy] 已迁出 ${removed.length} 条: ${removed.slice(0, 10).join(', ')}`)
if (added.length) {
  console.error(`[legacy] ❌ 新增 ${added.length} 条: ${added.join(', ')}`)
  console.error('[legacy] 基线只减不增(L1)。新命令必须走人工审定进 tier,不得搭 legacy 便车。')
  process.exit(1)
}
console.log('[legacy] ✅ 只减不增')
