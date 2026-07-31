import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoginStatusPanel } from './LoginStatusPanel'
import { useAppStore } from '../../store/appStore'
import { emptyPreferences } from '../../data/preferences'
import type { CommandManifest } from '../../data/types'
import type { PolicyDecision } from '../../data/policy'

const whoami = (site: string): CommandManifest => ({
  command: `${site}/whoami`, site, name: 'whoami', description: '', access: 'read', browser: true, args: [],
})

const ackRequired = (site: string): PolicyDecision => ({
  commandKey: `${site}/whoami`, state: 'acknowledgement-required', decisionSource: 'tier-evaluation',
  fingerprint: `fp-${site}`,
  metadata: {
    executionPath: 'browser-bridge', authorities: ['browser-profile'], exposure: 'personal',
    effects: [], credentialFlow: 'consume', residues: [],
  },
})

const unknownDecision = (site: string): PolicyDecision => ({
  commandKey: `${site}/whoami`, state: 'unknown', decisionSource: 'unclassified', reasonCode: 'no-tier',
})

function setup(over: Partial<Parameters<typeof useAppStore.setState>[0]> = {}) {
  useAppStore.setState({
    commands: [whoami('xiaohongshu'), whoami('bilibili'), whoami('chatgpt')],
    decisions: new Map([
      ['xiaohongshu/whoami', ackRequired('xiaohongshu')],
      ['bilibili/whoami', ackRequired('bilibili')],
      ['chatgpt/whoami', unknownDecision('chatgpt')],
    ]),
    preferences: emptyPreferences(),
    loginChecks: {}, loginQueue: [], loginInFlight: undefined,
    ...over,
  })
}

beforeEach(() => { localStorage.clear(); setup() })

test('未审定的站点如实列出并说明原因 —— 不藏起来,用户要看得见还差什么', () => {
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-state-chatgpt')).toHaveTextContent('未审定')
  expect(screen.getByTestId('login-row-chatgpt')).toHaveTextContent('尚未通过安全审定')
  // 它的刷新按钮必须是禁用的:点了也只会拿 403
  expect(screen.getByTestId('login-refresh-chatgpt')).toBeDisabled()
})

test('已放行但未确认 → 需先确认,给的是确认入口而不是刷新按钮', () => {
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-state-xiaohongshu')).toHaveTextContent('需先确认')
  expect(screen.getByTestId('login-ack-xiaohongshu')).toBeInTheDocument()
  expect(screen.queryByTestId('login-refresh-xiaohongshu')).not.toBeInTheDocument()
})

test('已确认 → 可检查,单站刷新只把该站入队', async () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-state-xiaohongshu')).toHaveTextContent('未检查')
  await userEvent.click(screen.getByTestId('login-refresh-xiaohongshu'))
  expect(useAppStore.getState().loginQueue).toEqual(['xiaohongshu'])
})

test('全部刷新只排可检查的站点 —— 未审定与待确认的不入队', async () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  useAppStore.getState().acknowledgeCommand('bilibili/whoami', 'fp-bilibili', 1)
  render(<LoginStatusPanel />)
  await userEvent.click(screen.getByTestId('refresh-all-logins'))
  const q = useAppStore.getState().loginQueue
  expect(q.sort()).toEqual(['bilibili', 'xiaohongshu'])
  expect(q).not.toContain('chatgpt')
})

test('摘要如实分类计数', () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-summary')).toHaveTextContent('1 个可检查')
  expect(screen.getByTestId('login-summary')).toHaveTextContent('1 个待确认')
  expect(screen.getByTestId('login-summary')).toHaveTextContent('1 个未审定')
})

test('判决在检查之后收紧 → 以判决为准,不沿用旧的「已登录」', () => {
  // 上次查出来是已登录,但现在判决已变成 unknown(比如策略收紧或 opencli 升级)
  setup({
    loginChecks: { chatgpt: { site: 'chatgpt', state: 'logged-in', checkedAt: 1, detail: '某账号' } },
  })
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-state-chatgpt')).toHaveTextContent('未审定')
  expect(screen.getByTestId('login-state-chatgpt')).not.toHaveTextContent('已登录')
})

test('自动刷新默认关,且开启后给出明确说明', async () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  render(<LoginStatusPanel />)
  const toggle = screen.getByTestId('auto-refresh-toggle')
  expect(toggle).not.toBeChecked()
  expect(screen.queryByTestId('auto-refresh-note')).not.toBeInTheDocument()
  await userEvent.click(toggle)
  // 文案必须说清它会**反复**动用登录态,而不是含糊的"定时检查"
  expect(screen.getByTestId('auto-refresh-note')).toHaveTextContent('反复')
  expect(screen.getByTestId('auto-refresh-note')).toHaveTextContent('登录态')
})

test('自动刷新配置落到布局那份存储,不进 preferences', async () => {
  render(<LoginStatusPanel />)
  await userEvent.click(screen.getByTestId('auto-refresh-toggle'))
  const layout = JSON.parse(localStorage.getItem('opencli-app:layout:v1')!)
  expect(layout.autoLoginRefresh).toBe(true)
  // preferences 里不得出现这个字段 —— 那份存储受 I-P7 管辖,只放执行确认与收藏
  const prefsRaw = localStorage.getItem('opencli-app:prefs:v2')
  expect(prefsRaw ?? '').not.toContain('autoLoginRefresh')
})

test('队列非空时按钮进入忙碌态,避免连点把队列堆爆', () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  setup({ loginQueue: ['xiaohongshu'], preferences: useAppStore.getState().preferences })
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('refresh-all-logins')).toBeDisabled()
  expect(screen.getByTestId('refresh-all-logins')).toHaveTextContent('检查中')
})
