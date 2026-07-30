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
import { reviewShapeHash } from './policy-fingerprint.mjs'

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

    // **这一条是本用例的命门。** 只断言「不在允许集里」对 deny 已**失去敏感度**:
    // paperreview/review 不在 legacy 基线(基线 = 派生 − 它)、strategy==='public' 又过不了
    // tierOf,所以就算把第 1 步的 deny 短路整个关掉,它照样落 unknown/no-tier、照样不在允许集,
    // 用例仍然全绿 —— 名字写着「deny 优先」,却对 deny 是死的。
    // 钉住**判决来源**才能真的守住 I-P3:关掉第 1 步,这行立刻红。
    expect(policy.decisionByKey.get('paperreview/review').decisionSource).toBe('explicit-deny')
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
    // 原断言是 `.toContain('覆盖表')` —— 对着字面写三条件的文案**照样绿**,挡不住它要挡的东西。
    // description 是用户可见文案(/health 的 executionPolicy 字段 + 启动日志),
    // 说的必须是当前真实事实源。故改成**能挡住旧文案**的形式。
    expect(policy.description).not.toContain('access=read')
    expect(policy.description).not.toContain('strategy=public')
    expect(policy.description).not.toContain('browser=false')
    // 正向:必须点名真正的两个来源与 fail-closed 缺省
    expect(policy.description).toContain('legacy 基线')
    expect(policy.description).toContain('tier')
    expect(policy.description).toContain('deny')
    expect(policy.description).toContain('fail-closed')
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

  it('执行面增量恰为三条 local-direct 加八条试点命令,且没有任何条目被移除', () => {
    // 只断言总数 287 挡不住「减掉一条 legacy、多进来两条别的」——必须钉住**增量本身**。
    // 试点开放后增量从 3 条变 11 条:多出的八条**逐条列名**,任何第九条溜进执行面都会红。
    const legacyDerived = new Set(snapshot.commands
      .filter((c) => c.access === 'read' && c.strategy === 'public' && c.browser === false)
      .map((c) => c.command)
      .filter((k) => COMMAND_POLICY_OVERRIDES[k]?.decision !== 'deny'))
    const added = [...policy.allowedCommands].filter((k) => !legacyDerived.has(k)).sort()
    const removed = [...legacyDerived].filter((k) => !policy.allowedCommands.has(k)).sort()
    expect(added).toEqual([
      'antigravity/recent-paths', 'bilibili/hot', 'bilibili/whoami',
      'mercury/reimbursement-plan', 'trae-cn/setup', 'twitter/timeline', 'twitter/whoami',
      'xiaohongshu/feed', 'xiaohongshu/whoami', 'youtube/subscriptions', 'youtube/whoami',
    ])
    expect(removed).toEqual([])
    expect(legacyDerived.size).toBe(276)
    expect(policy.allowedCommands.size).toBe(287)
  })

  it('注入缝不经 buildExecutionPolicy 透传 —— 传第二参也不改变任何判决', () => {
    // 今天这道缝在生产面不可达(buildExecutionPolicy 形参只有 snapshot、内部调用不带第二参、
    // HTTP 面够不着),但**此前没有任何断言钉住它**:将来有人给它加个 opts 往下转发,
    // 测试套件看不见。这里伪造一条**会放大执行面**的记录——若透传,
    // trae-solo/state-get 就从 unknown 变成 ready。
    const host = snapshot.commands.find((c) => c.command === 'trae-solo/state-get')
    const forged = new Map([['trae-solo/state-get', {
      reviewedAgainst: reviewShapeHash(host, snapshot.opencliVersion),
      metadata: {
        executionPath: 'direct-node', authorities: [], exposure: 'public',
        effects: [], credentialFlow: 'none', residues: [],
      },
    }]])
    const built = buildExecutionPolicy(snapshot, { records: forged })
    expect(built.decisionByKey.get('trae-solo/state-get').state).toBe('unknown')
    expect(built.decisions).toEqual(policy.decisions)
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

describe('确认校验与状态码', () => {
  const req = (over = {}) => ({
    runId: 'run-1', commandKey: 'antigravity/recent-paths',
    argv: ['antigravity', 'recent-paths', '-f', 'json'], ...over,
  })

  it('需确认但未带 acknowledgement → 428', () => {
    try { validateStartRequest(req(), policy); throw new Error('应当抛出') }
    catch (e) { expect(e.statusCode).toBe(428); expect(e.reasonCode).toBe('acknowledgement-required') }
  })

  it('fingerprint 不匹配 → 409', () => {
    try { validateStartRequest(req({ acknowledgement: { fingerprint: 'stale' } }), policy); throw new Error('应当抛出') }
    catch (e) { expect(e.statusCode).toBe(409) }
  })

  it('fingerprint 匹配 → 放行', () => {
    const fp = policy.decisionByKey.get('antigravity/recent-paths').fingerprint
    expect(validateStartRequest(req({ acknowledgement: { fingerprint: fp } }), policy).commandKey)
      .toBe('antigravity/recent-paths')
  })

  it('ready 的命令不需要 acknowledgement', () => {
    expect(validateStartRequest({ runId: 'r', commandKey: 'trae-cn/setup',
      argv: ['trae-cn', 'setup', '-f', 'json'] }, policy).commandKey).toBe('trae-cn/setup')
  })

  it('unknown 的命令 → 403 且 reasonCode 区分原因', () => {
    try {
      validateStartRequest({ runId: 'r', commandKey: 'trae-solo/state-get',
        argv: ['trae-solo', 'state-get', '-f', 'json'] }, policy)
      throw new Error('应当抛出')
    } catch (e) { expect(e.statusCode).toBe(403); expect(e.reasonCode).toBe('metadata-missing') }
  })

  it('显式 deny 的命令 → 403,reasonCode 与 unknown 区分得开', () => {
    try {
      validateStartRequest({ runId: 'r', commandKey: 'paperreview/review',
        argv: ['paperreview', 'review', 'tok', '-f', 'json'] }, policy)
      throw new Error('应当抛出')
    } catch (e) {
      expect(e.statusCode).toBe(403)
      expect(e.reasonCode).toBe('explicit-deny')      // 与 metadata-missing 那条互为对照
    }
  })

  it('结构非法 → 400,不被判决分派吞掉', () => {
    try { validateStartRequest({ runId: 'r', commandKey: 'trae-cn/setup', argv: 'not-an-array' }, policy); throw new Error('应当抛出') }
    catch (e) { expect(e.statusCode).toBe(400) }
  })
})

// ——— 试点命令的 argv 白名单(审定 §1.2 口径 F 的 P0)————————————————————————
// 为什么必须有这一层:`--trace` / `--site-session` / `--keep-tab` / `--window` 是 opencli 的
// **运行时全局选项**,不是 manifest args,因此不进 reviewShapeHash。而八条审定记录里
// `effects: []` 与 `residues: []` 的成立**以「不追加这些选项」为前提**。该前提此前只由前端
// buildArgv 保证 —— 而 I-P1 说绕过前端不得获得额外执行能力,这里恰恰能获得。
describe('试点 argv 白名单:只接受声明过的 flag 加 -f json', () => {
  const ack = policy.decisionByKey.get('xiaohongshu/feed').fingerprint
  const start = (argv, over = {}) => validateStartRequest({
    runId: 'r', commandKey: 'xiaohongshu/feed', argv,
    acknowledgement: { fingerprint: ack }, ...over,
  }, policy)

  it('声明过的 flag(--limit)照常放行 —— 白名单不是把命令锁死', () => {
    expect(start(['xiaohongshu', 'feed', '--limit', '20', '-f', 'json']).commandKey)
      .toBe('xiaohongshu/feed')
  })

  it('零 flag 也放行', () => {
    expect(start(['xiaohongshu', 'feed', '-f', 'json']).commandKey).toBe('xiaohongshu/feed')
  })

  it.each([
    ['--trace', ['xiaohongshu', 'feed', '--trace', 'on', '-f', 'json']],
    ['--site-session', ['xiaohongshu', 'feed', '--site-session', 'persistent', '-f', 'json']],
    ['--keep-tab', ['xiaohongshu', 'feed', '--keep-tab', 'true', '-f', 'json']],
    ['--window', ['xiaohongshu', 'feed', '--window', 'foreground', '-f', 'json']],
    ['--profile', ['xiaohongshu', 'feed', '--profile', 'other', '-f', 'json']],
    ['--trace=on(等号形式)', ['xiaohongshu', 'feed', '--trace=on', '-f', 'json']],
    ['-v(短选项)', ['xiaohongshu', 'feed', '-v', '-f', 'json']],
    ['裸位置参数(本命令声明 0 个位置参数)', ['xiaohongshu', 'feed', 'extra', '-f', 'json']],
  ])('%s → 400/argv-not-allowed', (_name, argv) => {
    try {
      start(argv)
      throw new Error('应当抛出')
    } catch (e) {
      expect(e).toBeInstanceOf(RequestPolicyError)
      expect(e.statusCode).toBe(400)
      expect(e.reasonCode).toBe('argv-not-allowed')
    }
  })

  it('声明过的 flag 后面塞标志当"值"也拦得住 —— --limit --trace 不得放行', () => {
    // 若只做「flag 名在白名单里」检查、无条件吃掉下一个 token,`--trace` 会被当成 --limit 的值
    // 混过去,而 commander 那边照样把它解析成一个开着的全局标志。
    try {
      start(['xiaohongshu', 'feed', '--limit', '--trace', '-f', 'json'])
      throw new Error('应当抛出')
    } catch (e) {
      expect(e.statusCode).toBe(400)
      expect(e.reasonCode).toBe('argv-not-allowed')
    }
  })

  it('白名单**只作用于试点命令** —— legacy 基线命令的 argv 形状不受影响', () => {
    // 范围有意收窄:legacy 276 条没有任何声称 effects/residues 的人工审定,
    // 不存在被 --trace 推翻的结论。贸然收紧会波及一大片未审定过 argv 形状的命令。
    // 这条同时是**误伤守卫**:白名单若漏挂成全局,这里会红。
    expect(policy.argvConstraintByKey.has('36kr/news')).toBe(false)
    expect(validateStartRequest({
      runId: 'r', commandKey: '36kr/news', argv: ['36kr', 'news', '--trace', 'on', '-f', 'json'],
    }, policy).commandKey).toBe('36kr/news')
  })

  it('八条试点命令都挂上了约束,且 flags 恰为各自 manifest 声明的集合', () => {
    const expected = new Map([
      ['xiaohongshu/whoami', []],
      ['xiaohongshu/feed', ['--limit']],
      ['bilibili/whoami', []],
      ['bilibili/hot', ['--limit']],
      ['twitter/whoami', []],
      ['twitter/timeline', ['--limit', '--top-by-engagement', '--type']],
      ['youtube/whoami', []],
      ['youtube/subscriptions', ['--limit']],
    ])
    expect([...policy.argvConstraintByKey.keys()].sort()).toEqual([...expected.keys()].sort())
    for (const [key, flags] of expected) {
      const constraint = policy.argvConstraintByKey.get(key)
      expect([...constraint.flags].sort(), key).toEqual(flags)
      expect(constraint.positionals, key).toBe(0)
    }
  })

  it('denied/unknown 优先于 argv 白名单 —— 带非法 flag 的被拒命令仍得 403,不是 400', () => {
    // 顺序是语义:先判「这条命令能不能跑」,再判「这次调用的形状对不对」。
    try {
      validateStartRequest({
        runId: 'r', commandKey: 'paperreview/review',
        argv: ['paperreview', 'review', 'tok', '--trace', 'on', '-f', 'json'],
      }, policy)
      throw new Error('应当抛出')
    } catch (e) {
      expect(e.statusCode).toBe(403)
      expect(e.reasonCode).toBe('explicit-deny')
    }
  })
})
