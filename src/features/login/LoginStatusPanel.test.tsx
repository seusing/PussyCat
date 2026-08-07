import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoginStatusPanel } from './LoginStatusPanel'
import { useAppStore } from '../../store/appStore'
import { emptyPreferences } from '../../data/preferences'
import type { CommandManifest } from '../../data/types'
import type { PolicyDecision } from '../../data/policy'

const command = (site: string, name: string, access: 'read' | 'write' = 'read'): CommandManifest => ({
  command: `${site}/${name}`, site, name, description: '', access, browser: true, args: [],
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
    commands: [
      command('xiaohongshu', 'whoami'), command('xiaohongshu', 'login', 'write'),
      command('bilibili', 'whoami'), command('bilibili', 'login', 'write'),
      command('chatgpt', 'whoami'),
    ],
    decisions: new Map([
      ['xiaohongshu/whoami', ackRequired('xiaohongshu')],
      ['bilibili/whoami', ackRequired('bilibili')],
      ['chatgpt/whoami', unknownDecision('chatgpt')],
    ]),
    preferences: emptyPreferences(),
    loginChecks: {}, loginQueue: [], loginInFlights: [],
    selected: undefined, pendingAcknowledgement: undefined, activeModule: 'login',
    ...over,
  })
}

async function clickRefresh(site: string) {
  await userEvent.click(screen.getByTestId(`login-refresh-${site}`))
}

beforeEach(() => { localStorage.clear(); setup() })

test('只渲染一张五列表格，不再出现登录状态分组', () => {
  render(<LoginStatusPanel />)
  expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
    'Site', 'User', 'Last Time', 'Status', 'Operation',
  ])
  expect(screen.getAllByRole('row')).toHaveLength(4)
  expect(screen.queryByTestId('login-group-action')).not.toBeInTheDocument()
  expect(screen.queryByTestId('login-group-logged-in')).not.toBeInTheDocument()
  expect(screen.queryByTestId('login-group-other')).not.toBeInTheDocument()
})

test('站点名前使用原版彩色 logo', () => {
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-logo-xiaohongshu')).toHaveAttribute('src', '/site-logos/xiaohongshu.svg')
  expect(screen.getByTestId('login-logo-bilibili')).toHaveAttribute('src', '/site-logos/bilibili.svg')
  expect(screen.getByTestId('login-row-xiaohongshu')).toHaveTextContent('小红书')
  expect(screen.getByTestId('login-row-bilibili')).toHaveTextContent('B站')
})

test('Badge 映射为 Success、Logging、Failed，并保留具体状态说明', () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  useAppStore.getState().acknowledgeCommand('bilibili/whoami', 'fp-bilibili', 1)
  setup({
    preferences: useAppStore.getState().preferences,
    loginChecks: {
      xiaohongshu: { site: 'xiaohongshu', state: 'logged-in', checkedAt: Date.now() - 2 * 60 * 60_000, detail: 'LauSeusing' },
      bilibili: { site: 'bilibili', state: 'checking' },
    },
  })
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-state-xiaohongshu')).toHaveTextContent('Success')
  expect(screen.getByTestId('login-state-xiaohongshu')).toHaveAttribute('title', '已登录')
  expect(screen.getByTestId('login-row-xiaohongshu')).toHaveTextContent('LauSeusing')
  expect(screen.getByTestId('login-row-xiaohongshu')).toHaveTextContent('2 小时前')
  expect(screen.getByTestId('login-state-bilibili')).toHaveTextContent('Logging')
  expect(screen.getByTestId('login-state-chatgpt')).toHaveTextContent('Failed')
})

test('刷新状态直接执行，只有独立箭头打开账号菜单', async () => {
  render(<LoginStatusPanel />)
  const refresh = screen.getByTestId('login-refresh-xiaohongshu')
  const trigger = screen.getByTestId('login-operation-xiaohongshu')
  expect(refresh).toHaveTextContent('刷新状态')
  expect(refresh).not.toHaveAttribute('aria-haspopup')
  expect(trigger).toHaveAccessibleName('更多账号操作')
  expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
  await userEvent.click(trigger)
  const menu = screen.getByRole('menu', { name: '小红书账号操作' })
  expect(within(menu).getAllByRole('menuitem')).toHaveLength(2)
  expect(within(menu).queryByText('刷新状态')).not.toBeInTheDocument()
  expect(within(menu).getByText('退出当前账号')).toBeInTheDocument()
  expect(within(menu).getByText('切换账号')).toBeInTheDocument()
})

test('未审定站点保留在表格中，刷新状态不可执行', async () => {
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-state-chatgpt')).toHaveAccessibleName('Failed：未审定')
  expect(screen.getByTestId('login-refresh-chatgpt')).toBeDisabled()
})

test('待确认站点选择刷新状态会打开原有确认流程', async () => {
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-state-xiaohongshu')).toHaveAccessibleName('Failed：需先确认')
  await clickRefresh('xiaohongshu')
  expect(useAppStore.getState().pendingAcknowledgement?.command.command).toBe('xiaohongshu/whoami')
  expect(useAppStore.getState().loginQueue).toEqual([])
})

test('已确认站点选择刷新状态只把该站入队', async () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  render(<LoginStatusPanel />)
  await clickRefresh('xiaohongshu')
  expect(useAppStore.getState().loginQueue).toEqual(['xiaohongshu'])
})

test('切换账号进入该站点真实 login 命令详情；无 logout 命令时退出项置灰', async () => {
  render(<LoginStatusPanel />)
  await userEvent.click(screen.getByTestId('login-operation-xiaohongshu'))
  const menu = screen.getByRole('menu', { name: '小红书账号操作' })
  expect(within(menu).getByRole('menuitem', { name: '退出当前账号' })).toBeDisabled()
  await userEvent.click(within(menu).getByRole('menuitem', { name: '切换账号' }))
  expect(useAppStore.getState().selected?.command).toBe('xiaohongshu/login')
  expect(useAppStore.getState().activeModule).toBe('commands')
})

test('菜单支持方向键与 Escape，并将焦点归还触发器', async () => {
  render(<LoginStatusPanel />)
  const trigger = screen.getByTestId('login-operation-xiaohongshu')
  trigger.focus()
  await userEvent.keyboard('{ArrowDown}')
  await waitFor(() => expect(screen.getByRole('menuitem', { name: '切换账号' })).toHaveFocus())
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

test('检查全部登录状态只排可检查的站点', async () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  useAppStore.getState().acknowledgeCommand('bilibili/whoami', 'fp-bilibili', 1)
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('refresh-all-logins')).toHaveAttribute('title', '刷新全部站点登录状态')
  await userEvent.click(screen.getByTestId('refresh-all-logins'))
  expect(useAppStore.getState().loginQueue.sort()).toEqual(['bilibili', 'xiaohongshu'])
})

test('工具栏不再显示分类摘要和队列提示文字', () => {
  render(<LoginStatusPanel />)
  expect(screen.queryByTestId('login-summary')).not.toBeInTheDocument()
  expect(screen.queryByTestId('login-queue-status')).not.toBeInTheDocument()
  expect(screen.queryByText('无待处理检查')).not.toBeInTheDocument()
})

test('判决在检查后收紧时以判决为准', () => {
  setup({ loginChecks: { chatgpt: { site: 'chatgpt', state: 'logged-in', checkedAt: 1, detail: '某账号' } } })
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-state-chatgpt')).toHaveAccessibleName('Failed：未审定')
  expect(screen.getByTestId('login-row-chatgpt')).not.toHaveTextContent('某账号')
})

test('定时检查默认关闭，开启后不显示额外提示', async () => {
  render(<LoginStatusPanel />)
  const toggle = screen.getByTestId('auto-refresh-toggle')
  const interval = screen.getByTestId('auto-refresh-minutes')
  expect(toggle).not.toBeChecked()
  expect(interval).toBeDisabled()
  await userEvent.click(toggle)
  expect(toggle).toBeChecked()
  expect(interval).toBeEnabled()
  expect(screen.queryByTestId('auto-refresh-note')).not.toBeInTheDocument()
})

test('自动刷新配置只写入布局存储', async () => {
  render(<LoginStatusPanel />)
  await userEvent.click(screen.getByTestId('auto-refresh-toggle'))
  expect(JSON.parse(localStorage.getItem('opencli-app:layout:v1')!).autoLoginRefresh).toBe(true)
  expect(localStorage.getItem('opencli-app:prefs:v2') ?? '').not.toContain('autoLoginRefresh')
})

test('单站排队不禁用其他站点的刷新操作', async () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  useAppStore.getState().acknowledgeCommand('bilibili/whoami', 'fp-bilibili', 1)
  setup({ preferences: useAppStore.getState().preferences })
  render(<LoginStatusPanel />)

  await clickRefresh('xiaohongshu')
  expect(screen.getByTestId('login-refresh-bilibili')).toBeEnabled()
  await clickRefresh('bilibili')
  expect(useAppStore.getState().loginQueue.sort()).toEqual(['bilibili', 'xiaohongshu'])
})

test('排队中与检查中都显示 Logging，但保留各自具体状态', () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  useAppStore.getState().acknowledgeCommand('bilibili/whoami', 'fp-bilibili', 1)
  setup({
    preferences: useAppStore.getState().preferences,
    loginQueue: ['bilibili'],
    loginInFlights: [{ site: 'xiaohongshu', runId: 'login-check:xiaohongshu:n1' }],
    loginChecks: {
      xiaohongshu: { site: 'xiaohongshu', state: 'checking' },
      bilibili: { site: 'bilibili', state: 'queued' },
    },
  })
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('login-state-xiaohongshu')).toHaveTextContent('Logging')
  expect(screen.getByTestId('login-state-xiaohongshu')).toHaveAttribute('title', '检查中')
  expect(screen.getByTestId('login-state-bilibili')).toHaveTextContent('Logging')
  expect(screen.getByTestId('login-state-bilibili')).toHaveAttribute('title', '排队中')
})

test('检查全部在已有任务排队时仍可继续补入队列', () => {
  useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
  setup({ loginQueue: ['xiaohongshu'], preferences: useAppStore.getState().preferences })
  render(<LoginStatusPanel />)
  expect(screen.getByTestId('refresh-all-logins')).toBeEnabled()
  expect(screen.getByTestId('refresh-all-logins')).toHaveTextContent('排队 1')
})
