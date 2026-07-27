// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildExecutionPolicy,
  COMMAND_POLICY_OVERRIDES,
  RequestPolicyError,
  loadExecutionPolicy,
  validateCancelRequest,
  validateStartRequest,
} from './policy.mjs'

const catalogPath = resolve('public/catalog.snapshot.json')
const policy = loadExecutionPolicy(catalogPath)
const snapshot = JSON.parse(readFileSync(catalogPath, 'utf8').replace(/^﻿/, ''))

describe('命令策略覆盖表(P1-B 能力模型的种子)', () => {
  it('deny 优先:满足全部派生条件也照样被拿掉', () => {
    const target = snapshot.commands.find((c) => c.command === 'paperreview/review')
    // **先钉住前提**:它确实满足派生规则。哪天 catalog 把它改成 browser=true,
    // 下面那条断言就会因为"它本来就不该在里面"而变成假绿 —— 这几行让那种情况当场失败。
    expect(target).toBeDefined()
    expect(target.access).toBe('read')
    expect(target.strategy).toBe('public')
    expect(target.browser).toBe(false)

    expect(policy.allowedCommands.has('paperreview/review')).toBe(false)
  })

  it('只做减法:派生集恰好少掉被 deny 的那些,既有命令不受影响', () => {
    // 事实源已换成判决(Task 4:allowedCommands 由 decisions 派生),但**断言的仍是关系
    // 而非魔法数字** —— catalog 漂移时不会误红,deny 没生效时一定红。
    const runnable = policy.decisions
      .filter((d) => d.state === 'ready' || d.state === 'acknowledgement-required')
      .map((d) => d.commandKey)
    expect([...policy.allowedCommands].sort()).toEqual([...runnable].sort())
    // 「只做减法」在新事实源下的形式:被 deny 的命令必然不可执行,且判决说得出**为什么**。
    for (const [key, rule] of Object.entries(COMMAND_POLICY_OVERRIDES)) {
      if (rule.decision !== 'deny') continue
      expect(policy.allowedCommands.has(key), key).toBe(false)
      expect(policy.decisionByKey.get(key).decisionSource, key).toBe('explicit-deny')
    }
    expect(policy.allowedCommands.has('36kr/news')).toBe(true)
  })

  it('deny 理由进入 403 detail,而不是只回一个命令名', () => {
    let thrown
    try {
      validateStartRequest({
        runId: 'run-1',
        commandKey: 'paperreview/review',
        argv: ['paperreview', 'review', 'tok', '-f', 'json'],
      }, policy)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RequestPolicyError)
    expect(thrown.statusCode).toBe(403)
    expect(thrown.detail).toContain('capability token')
  })

  it('覆盖表里的陈旧 key 会被抓出来(CI 门)', () => {
    const known = new Set(snapshot.commands.map((c) => c.command))
    const stale = Object.keys(COMMAND_POLICY_OVERRIDES).filter((key) => !known.has(key))
    expect(stale).toEqual([])
  })

  it('覆盖表只允许 deny —— 写错的 allow 会**扩大**执行面,代价与写错 deny 不对称', () => {
    const nonDeny = Object.entries(COMMAND_POLICY_OVERRIDES)
      .filter(([, rule]) => rule.decision !== 'deny')
    expect(nonDeny).toEqual([])
  })

  it('description 不再声称执行面完全由三条件决定', () => {
    expect(policy.description).toContain('覆盖表')
  })

  it('直接调用唯一咽喉 buildExecutionPolicy 时 deny 仍优先', () => {
    const built = buildExecutionPolicy({
      opencliVersion: '9.9.9',
      commands: [
        { command: 'paperreview/review', access: 'read', strategy: 'public', browser: false },
        { command: 'demo/ok', access: 'read', strategy: 'public', browser: false },
      ],
    })
    // 正向控制:证明这次调用确实产出了判决(9.9.9 下 legacy 基线集体失效,允许集为空是
    // spec §4.1.2 的预期行为,故控制臂改从 decisionByKey 取)。
    expect(built.decisionByKey.get('demo/ok')).toBeDefined()
    // deny 臂**加强**:钉住被拒的**原因**,而不只是「不在允许集里」——后者在空集上平凡成立。
    expect(built.decisionByKey.get('paperreview/review').decisionSource).toBe('explicit-deny')
    expect(built.allowedCommands.has('paperreview/review')).toBe(false)
    expect(built.deniedCommands.get('paperreview/review')).toContain('capability token')
  })
})

describe('判决与允许集的单一事实源(Task 4 新增守卫)', () => {
  it('allowedCommands 与判决恒等 —— 任一方向不一致即红', () => {
    const runnable = new Set(policy.decisions
      .filter((d) => d.state === 'ready' || d.state === 'acknowledgement-required')
      .map((d) => d.commandKey))
    // 方向一:允许集里的每一条,判决都必须认为它可执行(否则允许集比判决宽 = 绕过判决)
    for (const key of policy.allowedCommands) {
      expect(runnable.has(key), `${key} 在 allowedCommands 里,判决却不可执行`).toBe(true)
    }
    // 方向二:判决认为可执行的每一条,都必须在允许集里(否则判决比允许集宽 = 判决被吞)
    for (const key of runnable) {
      expect(policy.allowedCommands.has(key), `${key} 判决可执行,却不在 allowedCommands 里`).toBe(true)
    }
    expect(policy.allowedCommands.size).toBe(runnable.size)
  })

  it('执行面增量恰为三条人工审定命令,且没有任何条目被移除', () => {
    // 只断言总数 279 挡不住「减掉一条 legacy、多进来两条别的」——必须钉住**增量本身**。
    const legacyDerived = new Set(snapshot.commands
      .filter((c) => c.access === 'read' && c.strategy === 'public' && c.browser === false)
      .map((c) => c.command)
      .filter((k) => COMMAND_POLICY_OVERRIDES[k]?.decision !== 'deny'))
    const added = [...policy.allowedCommands].filter((k) => !legacyDerived.has(k)).sort()
    const removed = [...legacyDerived].filter((k) => !policy.allowedCommands.has(k)).sort()
    expect(added).toEqual([
      'antigravity/recent-paths', 'mercury/reimbursement-plan', 'trae-cn/setup',
    ])
    expect(removed).toEqual([])
    expect(legacyDerived.size).toBe(276)
    expect(policy.allowedCommands.size).toBe(279)
  })
})

describe('P0-B execution policy', () => {
  it('allows 36kr/news and pins catalog/OpenCLI version', () => {
    expect(policy.opencliVersion).toBe('1.8.6')
    expect(policy.allowedCommands.has('36kr/news')).toBe(true)
    expect(validateStartRequest({
      runId: 'run-1',
      commandKey: '36kr/news',
      argv: ['36kr', 'news', '-f', 'json'],
    }, policy)).toEqual({
      runId: 'run-1',
      commandKey: '36kr/news',
      argv: ['36kr', 'news', '-f', 'json'],
    })
  })

  it('rejects commandKey/argv mismatch and commands outside public read scope', () => {
    expect(() => validateStartRequest({
      runId: 'run-1',
      commandKey: '36kr/news',
      argv: ['bbc', 'news', '-f', 'json'],
    }, policy)).toThrow(/does not match/)

    expect(() => validateStartRequest({
      runId: 'run-2',
      commandKey: '12306/login',
      argv: ['12306', 'login', '-f', 'json'],
    }, policy)).toThrow(RequestPolicyError)
  })

  it('requires explicit JSON as the effective output format', () => {
    expect(() => validateStartRequest({
      runId: 'run-1',
      commandKey: '36kr/news',
      argv: ['36kr', 'news'],
    }, policy)).toThrow(/explicit JSON/)
    expect(() => validateStartRequest({
      runId: 'run-2',
      commandKey: '36kr/news',
      argv: ['36kr', 'news', '-f', 'json', '--format=yaml'],
    }, policy)).toThrow(/explicit JSON/)
  })

  it('validates cancel run ids', () => {
    expect(validateCancelRequest({ runId: 'run:abc-1' })).toEqual({ runId: 'run:abc-1' })
    expect(() => validateCancelRequest({ runId: '../bad' })).toThrow(/Invalid runId/)
  })
})

// 改名自「buildExecutionPolicy: 纯函数过滤 read+public+browser=false」——
// 那个名字就是 spec §4.3 已**废除**的三条件规则本身(public-direct 不再是需要允许集的 tier,
// 改由 legacy 基线承接)。留着旧名字就是本仓反复栽过的「名字比内容大」。
it('buildExecutionPolicy: 三条件不再等于准入 —— 不在基线又不落 tier 的命令一律 unknown/no-tier', () => {
  const policy = buildExecutionPolicy({
    opencliVersion: '9.9.9',
    commands: [
      { command: 'a/ok', access: 'read', strategy: 'public', browser: false },
      { command: 'a/write', access: 'write', strategy: 'public', browser: false },
      { command: 'a/priv', access: 'read', strategy: 'private', browser: false },
      { command: 'a/br', access: 'read', strategy: 'public', browser: true },
    ],
  })
  // a/ok 满足全部三条件,但它不在 legacy 基线里(捏造的 key)、strategy 也不是 local
  // (过不了 tierOf) → 落 unknown/no-tier。**这是 I-P2 fail-closed 的直接守卫**:
  // 没人审定过的命令不得可执行,比原来的「三条件即准入」更强。
  expect(policy.decisionByKey.get('a/ok').state).toBe('unknown')
  expect(policy.decisionByKey.get('a/ok').reasonCode).toBe('no-tier')
  expect([...policy.allowedCommands]).toEqual([])
  // 判决覆盖**全目录**,不是只发给「过了三条件」的那些。
  expect(policy.decisions).toHaveLength(4)
  for (const key of ['a/ok', 'a/write', 'a/priv', 'a/br']) {
    expect(policy.decisionByKey.get(key).state, key).toBe('unknown')
  }
  expect(policy.opencliVersion).toBe('9.9.9')
})

it('buildExecutionPolicy: commands 非数组 → throw', () => {
  expect(() => buildExecutionPolicy({})).toThrow()
})
