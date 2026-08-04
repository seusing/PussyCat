/**
 * RunManager 的**实际接线值** —— 单独成模块只为一个理由:它必须能被测到。
 *
 * 这段逻辑原先内联在 index.mjs 里,而 index.mjs 一 import 就启动服务,测不了。
 * 于是发生过这样一次回归:并发上限在 RunManager 构造函数里改成了 4,但这里的
 * `?? '1'` 把它完全盖掉,测试只覆盖了构造函数默认值 —— 全绿,真机上却是前端发 3 个、
 * Host 只收 1 个,另外两个当场吃 429「Maximum concurrent runs reached」。
 * **默认值和接线值是两个东西**,要测就测这个。
 */

/**
 * 4 = 前端后台登录体检占的 3(src/App.tsx 的 LOGIN_CHECK_CONCURRENCY)
 *   + 留给用户手动发起命令的 1。
 * 两个数字必须一起看:前端调大而这里没跟上,多出来的请求就是 429。
 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 4

/** 无效或非正的环境变量一律回落到默认值 —— 一个 NaN 会让并发闸门彻底失效。 */
function positiveInt(raw, fallback) {
  const value = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function resolveRunManagerOptions(env = process.env) {
  return {
    cancelGraceMs: positiveInt(env.OPENCLI_HOST_CANCEL_GRACE_MS, 2000),
    commandTimeoutMs: positiveInt(env.OPENCLI_HOST_COMMAND_TIMEOUT_MS, 90_000),
    maxConcurrentRuns: positiveInt(env.OPENCLI_HOST_MAX_CONCURRENT_RUNS, DEFAULT_MAX_CONCURRENT_RUNS),
  }
}
