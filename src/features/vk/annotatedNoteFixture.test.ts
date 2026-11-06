// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 引擎输出的图文笔记样例要能过 comark-annotate 自带的校验(命令行 `comark-annotate check`,问题数为 0 时退出码 0)。
const cli = fileURLToPath(new URL('../../../node_modules/comark-annotate/dist/cli.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/annotated-note.md', import.meta.url))

function check(file: string) {
  return spawnSync(process.execPath, [cli, 'check', file], { encoding: 'utf8' })
}

describe('图文笔记样例', () => {
  it('comark-annotate check 退出码为 0', () => {
    const result = check(fixture)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('No problems')
    expect(result.status).toBe(0)
  })

  it('校验确实会拦下不合法的批注(退出码 1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'annotated-note-'))
    try {
      const bad = join(dir, 'bad.md')
      writeFileSync(bad, '::screenshot{src="figures/3fa9c1d2e4b5.jpg" alt="图3" viewport="10x10"}\n:::annotation{x=1 y=1 w=1 h=1 mark="bogus"}\n批注\n:::\n::\n')
      const result = check(bad)
      expect(result.stderr).toContain('`mark` must be one of')
      expect(result.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
