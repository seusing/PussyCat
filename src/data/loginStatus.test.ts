import {
  clampIntervalMinutes, isLoginCheckRunId, loginCheckRunId, parseWhoamiResult,
  siteOfLoginCheckRunId, stateFromDecision,
  AUTO_REFRESH_DEFAULT_MINUTES, AUTO_REFRESH_MAX_MINUTES, AUTO_REFRESH_MIN_MINUTES,
} from './loginStatus'
import type { PolicyDecision } from './policy'

const decision = (over: Partial<PolicyDecision>): PolicyDecision => ({
  commandKey: 'x/whoami', state: 'ready', decisionSource: 'legacy-baseline', ...over,
})

describe('由判决决定可检查状态 —— 前端不复制准入规则', () => {
  test('ready → 可查', () => {
    expect(stateFromDecision(decision({ state: 'ready' }), false)).toBe('unchecked')
  })

  test('acknowledgement-required:已确认才可查,未确认要先确认', () => {
    const d = decision({ state: 'acknowledgement-required', fingerprint: 'fp' })
    expect(stateFromDecision(d, true)).toBe('unchecked')
    expect(stateFromDecision(d, false)).toBe('needs-ack')
  })

  test.each([
    ['denied' as const],
    ['unknown' as const],
  ])('%s → not-approved(该站 whoami 尚未审定,Host 会 403)', (state) => {
    expect(stateFromDecision(decision({ state }), true)).toBe('not-approved')
  })

  test('判决缺失(Host 未连接)→ not-approved,**不乐观假设可查**', () => {
    expect(stateFromDecision(undefined, true)).toBe('not-approved')
  })
})

describe('runId 分流 —— 登录检查不进运行面板', () => {
  test('生成的 runId 可被识别并反解出站点', () => {
    const id = loginCheckRunId('xiaohongshu', 'abc123')
    expect(isLoginCheckRunId(id)).toBe(true)
    expect(siteOfLoginCheckRunId(id)).toBe('xiaohongshu')
  })

  test('普通运行的 runId 不被误判', () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    expect(isLoginCheckRunId(uuid)).toBe(false)
    expect(siteOfLoginCheckRunId(uuid)).toBeUndefined()
  })

  test('站点名含冒号也能正确反解(取最后一个冒号分隔 nonce)', () => {
    const id = loginCheckRunId('weird:site', 'n1')
    expect(siteOfLoginCheckRunId(id)).toBe('weird:site')
  })
})

describe('whoami 返回体解析', () => {
  test('logged_in 为真 → 已登录,并取账号标识作补充', () => {
    expect(parseWhoamiResult([{ logged_in: true, username: '阿猫' }]))
      .toEqual({ state: 'logged-in', detail: '阿猫' })
  })

  test('字符串形态的真/假同样识别(适配器不保证给布尔)', () => {
    expect(parseWhoamiResult([{ logged_in: 'true' }]).state).toBe('logged-in')
    expect(parseWhoamiResult([{ logged_in: 'false' }]).state).toBe('logged-out')
  })

  test('数值形态的账号标识(如 B 站 mid)也能展示', () => {
    expect(parseWhoamiResult([{ logged_in: true, id: 12345 }]))
      .toEqual({ state: 'logged-in', detail: '12345' })
  })

  test('**拿不准一律判 error,不判已登录** —— 那会让用户以为会话还在', () => {
    expect(parseWhoamiResult([{ logged_in: 'maybe' }]).state).toBe('error')
    expect(parseWhoamiResult([{ site: 'x' }]).state).toBe('error')
    expect(parseWhoamiResult([]).state).toBe('error')
    expect(parseWhoamiResult(undefined).state).toBe('error')
  })

  test('已登录但没有可展示的账号字段时不编造 detail', () => {
    expect(parseWhoamiResult([{ logged_in: true }])).toEqual({ state: 'logged-in' })
  })

  test('不把整个返回体摊到界面上 —— 只取约定的三个字段之一', () => {
    const r = parseWhoamiResult([{ logged_in: true, followers: 999, email: 'a@b.c', username: '阿猫' }])
    expect(r.detail).toBe('阿猫')
  })
})

describe('自动刷新间隔夹取', () => {
  test('低于下限夹到 5 分钟 —— whoami 会真的开浏览器标签,更密只是打扰', () => {
    expect(clampIntervalMinutes(1)).toBe(AUTO_REFRESH_MIN_MINUTES)
    expect(clampIntervalMinutes(0)).toBe(AUTO_REFRESH_MIN_MINUTES)
    expect(clampIntervalMinutes(-100)).toBe(AUTO_REFRESH_MIN_MINUTES)
  })

  test('高于上限夹到 240 分钟', () => {
    expect(clampIntervalMinutes(99999)).toBe(AUTO_REFRESH_MAX_MINUTES)
  })

  test('非数值退默认值,不抛', () => {
    expect(clampIntervalMinutes('30' as unknown)).toBe(AUTO_REFRESH_DEFAULT_MINUTES)
    expect(clampIntervalMinutes(NaN)).toBe(AUTO_REFRESH_DEFAULT_MINUTES)
    expect(clampIntervalMinutes(undefined)).toBe(AUTO_REFRESH_DEFAULT_MINUTES)
  })

  test('区间内取整保留', () => {
    expect(clampIntervalMinutes(45.4)).toBe(45)
  })
})
