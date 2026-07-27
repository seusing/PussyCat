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
    const derived = snapshot.commands.filter((c) => (
      c.access === 'read' && c.strategy === 'public' && c.browser === false
    ))
    const deniedInCatalog = Object.entries(COMMAND_POLICY_OVERRIDES)
      .filter(([key, rule]) => rule.decision === 'deny' && derived.some((c) => c.command === key))
    // 断言的是**关系**不是魔法数字:catalog 漂移时不会误红,但 deny 没生效时一定红。
    expect(policy.allowedCommands.size).toBe(derived.length - deniedInCatalog.length)
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
    expect(built.allowedCommands.has('demo/ok')).toBe(true)
    expect(built.allowedCommands.has('paperreview/review')).toBe(false)
    expect(built.deniedCommands.get('paperreview/review')).toContain('capability token')
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

it('buildExecutionPolicy: 纯函数过滤 read+public+browser=false', () => {
  const policy = buildExecutionPolicy({
    opencliVersion: '9.9.9',
    commands: [
      { command: 'a/ok', access: 'read', strategy: 'public', browser: false },
      { command: 'a/write', access: 'write', strategy: 'public', browser: false },
      { command: 'a/priv', access: 'read', strategy: 'private', browser: false },
      { command: 'a/br', access: 'read', strategy: 'public', browser: true },
    ],
  })
  expect([...policy.allowedCommands]).toEqual(['a/ok'])
  expect(policy.opencliVersion).toBe('9.9.9')
})

it('buildExecutionPolicy: commands 非数组 → throw', () => {
  expect(() => buildExecutionPolicy({})).toThrow()
})
