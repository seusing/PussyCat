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

test('检查全部登录状态只排可检查的站点 —— 未审定与待确认的不入队', async () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  useAppStore.getState().acknowledgeCommand('bilibili/whoami', 'fp-bilibili', 1)
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('refresh-all-logins')).toHaveTextContent('检查全部登录状态')
  expect(screen.getByTestId('refresh-all-logins')).toHaveAttribute('title', expect.stringContaining('可能唤起或切换浏览器标签'))
  expect(screen.getByTestId('auto-refresh-toggle').parentElement).toHaveTextContent('定时检查')
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

test('定时检查默认关,且开启后给出明确说明', async () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  render(<LoginStatusPanel />)
  const toggle = screen.getByTestId('auto-refresh-toggle')
  expect(toggle).not.toBeChecked()
  expect(screen.queryByTestId('auto-refresh-note')).not.toBeInTheDocument()
  await userEvent.click(toggle)
  // 文案必须说清它会**反复**动用登录态,而不是含糊的"定时检查"
  expect(screen.getByTestId('auto-refresh-note')).toHaveTextContent('反复')
  expect(screen.getByTestId('auto-refresh-note')).toHaveTextContent('登录态')
  expect(screen.getByTestId('auto-refresh-note')).toHaveTextContent('可能唤起或切换浏览器标签')
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

test('**点一个站点不会让其他站点变灰** —— 串行执行是排队,不是全局互斥', async () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  useAppStore.getState().acknowledgeCommand('bilibili/whoami', 'fp-bilibili', 1)
  const prefs = useAppStore.getState().preferences
  setup({ preferences: prefs })
  render(<LoginStatusPanel />)

  await userEvent.click(screen.getByTestId('login-refresh-xiaohongshu'))

  // 被点的那个进入队列、按钮禁用(避免重复入列)
  expect(screen.getByTestId('login-refresh-xiaohongshu')).toBeDisabled()
  // **其他站点必须仍然可点** —— 这是本次修复的命门
  expect(screen.getByTestId('login-refresh-bilibili')).toBeEnabled()

  // 点第二个:两个都排上,互不阻塞
  await userEvent.click(screen.getByTestId('login-refresh-bilibili'))
  expect(useAppStore.getState().loginQueue.sort()).toEqual(['bilibili', 'xiaohongshu'])
})

test('排队中与检查中分开显示 —— 等待中的不谎称正在跑', () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  useAppStore.getState().acknowledgeCommand('bilibili/whoami', 'fp-bilibili', 1)
  const prefs = useAppStore.getState().preferences
  setup({
    preferences: prefs,
    loginQueue: ['bilibili'],
    loginInFlight: { site: 'xiaohongshu', runId: 'login-check:xiaohongshu:n1' },
    loginChecks: {
      xiaohongshu: { site: 'xiaohongshu', state: 'checking' },
      bilibili: { site: 'bilibili', state: 'queued' },
    },
  })
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-state-xiaohongshu')).toHaveTextContent('检查中')
  expect(screen.getByTestId('login-state-bilibili')).toHaveTextContent('排队中')
  expect(screen.getByTestId('login-state-bilibili')).not.toHaveTextContent('检查中')
})

test('登录站点按需要处理、已登录、未配置或其他分组,默认仅展开需要处理', () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  setup({
    preferences: useAppStore.getState().preferences,
    loginChecks: {
      xiaohongshu: { site: 'xiaohongshu', state: 'logged-in', checkedAt: 1 },
      bilibili: { site: 'bilibili', state: 'logged-out', checkedAt: 1 },
    },
  })
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-group-action')).toHaveAttribute('open')
  expect(screen.getByTestId('login-group-logged-in')).not.toHaveAttribute('open')
  expect(screen.getByTestId('login-group-other')).not.toHaveAttribute('open')
  expect(screen.getByTestId('login-row-bilibili')).toBeVisible()
  expect(screen.getByTestId('login-row-xiaohongshu')).not.toBeVisible()
  expect(screen.getByTestId('login-row-chatgpt')).not.toBeVisible()
})

test('检查队列显示当前站点与剩余数量', () => {
  setup({
    loginQueue: ['bilibili', 'chatgpt'],
    loginInFlight: { site: 'xiaohongshu', runId: 'login-check:xiaohongshu:n1' },
    loginChecks: {
      xiaohongshu: { site: 'xiaohongshu', state: 'checking' },
      bilibili: { site: 'bilibili', state: 'queued' },
      chatgpt: { site: 'chatgpt', state: 'queued' },
    },
  })
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-queue-status')).toHaveTextContent('小红书')
  expect(screen.getByTestId('login-queue-status')).toHaveTextContent('剩余 2')
})

test('「检查全部登录状态」在有任务排队时仍可点 —— 它只是把剩下的加进队列', () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  setup({ loginQueue: ['xiaohongshu'], preferences: useAppStore.getState().preferences })
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('refresh-all-logins')).toBeEnabled()
  expect(screen.getByTestId('refresh-all-logins')).toHaveTextContent('排队 1')
})
