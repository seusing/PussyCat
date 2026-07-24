// @vitest-environment node
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RequestPolicyError,
  loadExecutionPolicy,
  validateCancelRequest,
  validateStartRequest,
} from './policy.mjs'

const policy = loadExecutionPolicy(resolve('public/catalog.snapshot.json'))

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

import { buildExecutionPolicy } from './policy.mjs'

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
