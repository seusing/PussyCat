import { describe, expect, test } from 'vitest'
import { DEFAULT_MAX_CONCURRENT_RUNS, resolveRunManagerOptions } from './run-manager-options.mjs'
import { RunManager } from './run-manager.mjs'

describe('RunManager 接线值', () => {
  test('默认并发上限是 4 —— 这是**接线**值,不是构造函数默认值', () => {
    // 回归钉:曾经只改了 RunManager 的构造函数默认值,而 index.mjs 里写死的 '1'
    // 把它盖掉,于是前端发 3 个、Host 只收 1 个,另外两个吃 429。
    expect(resolveRunManagerOptions({}).maxConcurrentRuns).toBe(4)
    expect(DEFAULT_MAX_CONCURRENT_RUNS).toBe(4)
  })

  test('接线值必须容得下前端的后台体检并发 + 1 个手动位', () => {
    // 前端 src/App.tsx 的 LOGIN_CHECK_CONCURRENCY 是 3;两个数字必须一起看,
    // 任一边单独调整都会重演 429。这条把它们的关系钉在测试里。
    const LOGIN_CHECK_CONCURRENCY = 3
    expect(resolveRunManagerOptions({}).maxConcurrentRuns).toBeGreaterThanOrEqual(LOGIN_CHECK_CONCURRENCY + 1)
  })

  test('构造函数默认值与接线值一致 —— 不一致正是上次翻车的形状', () => {
    const manager = new RunManager({ opencliEntry: '/x.js', emitEvent: () => {} })
    expect(manager.maxConcurrentRuns).toBe(resolveRunManagerOptions({}).maxConcurrentRuns)
  })

  test('环境变量可覆盖(真机上并发压力过大时的退路)', () => {
    expect(resolveRunManagerOptions({ OPENCLI_HOST_MAX_CONCURRENT_RUNS: '1' }).maxConcurrentRuns).toBe(1)
    expect(resolveRunManagerOptions({ OPENCLI_HOST_COMMAND_TIMEOUT_MS: '5000' }).commandTimeoutMs).toBe(5000)
    expect(resolveRunManagerOptions({ OPENCLI_HOST_CANCEL_GRACE_MS: '500' }).cancelGraceMs).toBe(500)
  })

  test('非法值回落默认,不让 NaN 把并发闸门废掉', () => {
    // parseInt('abc') 是 NaN,而 active.size >= NaN 恒为 false —— 闸门等于不存在。
    expect(resolveRunManagerOptions({ OPENCLI_HOST_MAX_CONCURRENT_RUNS: 'abc' }).maxConcurrentRuns).toBe(4)
    expect(resolveRunManagerOptions({ OPENCLI_HOST_MAX_CONCURRENT_RUNS: '0' }).maxConcurrentRuns).toBe(4)
    expect(resolveRunManagerOptions({ OPENCLI_HOST_MAX_CONCURRENT_RUNS: '-3' }).maxConcurrentRuns).toBe(4)
  })
})
