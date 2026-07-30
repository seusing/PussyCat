// @vitest-environment node
//
// 覆盖 scripts/check-legacy-baseline.mjs 的两条路径:
//   - 真实比较路径(自比自 / 新增 / 删除)
//   - 首次引入路径(base ref 上尚无基线文件)
// 以及 fail-closed 的两个边界(base ref 不存在、base ref 上文件是坏 JSON)。
//
// 脚本本身从自身位置推导 repo root,测试跑不到真实仓库上——为此脚本加了
// LEGACY_REPO_ROOT 注入缝(与 server/policy.mjs 的 OPENCLI_HOST_LEGACY_BASELINE_PATH 同一套路),
// 这里在 os.tmpdir() 下建一个临时 git 仓,把闸门指过去,不碰本仓自己的基线文件。
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'check-legacy-baseline.mjs')
const execFileAsync = promisify(execFile)

const GOOD_BASELINE = {
  materializedFrom: {},
  opencliVersion: 'x',
  entries: { 'a/b': 'h1', 'c/d': 'h2' },
}

let tmpRepo
let baselinePath
let noBaselineRef // base ref 上没有该文件 —— 首次引入路径(B6)
let corruptRef // base ref 上的文件是坏 JSON —— fail-closed 路径(B5)

function git(args) {
  return execFileSync('git', args, { cwd: tmpRepo, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function writeBaseline(content) {
  writeFileSync(baselinePath, `${JSON.stringify(content, null, 2)}\n`)
}

// util.promisify(execFile) 在子进程非零退出时 reject,但 reject 出的 error 对象上
// 仍带 code(退出码)/stdout/stderr——这是 Node 对 exec/execFile 的一贯行为。
// 闸门的契约是退出码,所以这里无论进程是 0 退出还是非 0 退出,都统一取 {code, stdout, stderr},
// 不分两套断言逻辑。
async function runGate(baseRef) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, LEGACY_REPO_ROOT: tmpRepo, LEGACY_BASE_REF: baseRef },
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr }
  }
}

beforeAll(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'opencli-legacy-baseline-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'legacy-baseline-test@local.invalid'])
  git(['config', 'user.name', 'legacy-baseline-test'])

  mkdirSync(join(tmpRepo, 'server'), { recursive: true })
  baselinePath = join(tmpRepo, 'server', 'policy-legacy-baseline.json')

  // commit 1:尚无基线文件的树 —— B6(首次引入)要比较的就是这一棵
  writeFileSync(join(tmpRepo, 'server', '.gitkeep'), '')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init without baseline'])
  noBaselineRef = git(['rev-parse', 'HEAD'])

  // commit 2:加入好基线,成为 main 分支尖 —— B1/B2/B3/B4 都拿它当 base
  writeBaseline(GOOD_BASELINE)
  git(['add', '.'])
  git(['commit', '-q', '-m', 'add baseline'])

  // 游离 commit:同一路径,内容是坏 JSON —— B5 专用,不挂在任何分支上
  // (做法与计划文档 Task 3 Step 7-B5 一致:detach → 改坏 → commit → 记 sha → 切回 main)
  git(['checkout', '-q', '--detach'])
  writeFileSync(baselinePath, '{ CORRUPT')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'corrupt baseline'])
  corruptRef = git(['rev-parse', 'HEAD'])
  git(['checkout', '-q', 'main'])
})

afterAll(() => {
  try {
    rmSync(tmpRepo, { recursive: true, force: true })
  } catch {
    // 清理失败不应让测试结果变红——残留由系统 tmp 目录清理兜底。
  }
})

// 脚本的 current 永远直接读盘,与 git 索引/HEAD 无关;每条用例开始前把磁盘上的
// 「当前」基线复位成好基线,不需要 git add/commit,保证用例互不污染。
beforeEach(() => {
  writeBaseline(GOOD_BASELINE)
})

describe('check-legacy-baseline:真实比较路径', () => {
  it('B1 自比自(LEGACY_BASE_REF=HEAD,工作区与 HEAD 相同)→ exit 0,只减不增', async () => {
    const { code, stdout } = await runGate('HEAD')
    expect(code).toBe(0)
    expect(stdout).toContain('只减不增')
  })

  it('B2 基线存在后新增条目 → exit 1,点名新增的 key', async () => {
    writeBaseline({ ...GOOD_BASELINE, entries: { ...GOOD_BASELINE.entries, 'fake/cmd': '0' } })
    const { code, stderr } = await runGate('HEAD')
    expect(code).toBe(1)
    expect(stderr).toContain('fake/cmd')
  })

  it('B3 删一条 → exit 0,报已迁出 1 条', async () => {
    const entries = { ...GOOD_BASELINE.entries }
    delete entries['c/d']
    writeBaseline({ ...GOOD_BASELINE, entries })
    const { code, stdout } = await runGate('HEAD')
    expect(code).toBe(0)
    expect(stdout).toContain('已迁出 1 条')
    expect(stdout).toContain('c/d')
  })
})

describe('check-legacy-baseline:fail-closed 与首次引入路径', () => {
  it('B4 LEGACY_BASE_REF 指向不存在的 ref → exit 1,报 base ref 不存在(fail-closed)', async () => {
    const { code, stderr } = await runGate('nonexistent/ref-should-not-exist')
    expect(code).toBe(1)
    expect(stderr).toContain("base ref 'nonexistent/ref-should-not-exist' 不存在")
  })

  it('B5 base ref 上的基线文件是坏 JSON → exit 1,报解析失败,不得复用「尚无基线」话术', async () => {
    const { code, stderr } = await runGate(corruptRef)
    expect(code).toBe(1)
    expect(stderr).toContain('解析失败')
  })

  it('B6 base ref 上尚无该文件 → exit 0,首次引入,跳过 diff 检查', async () => {
    const { code, stdout } = await runGate(noBaselineRef)
    expect(code).toBe(0)
    expect(stdout).toContain('尚无基线')
  })
})
