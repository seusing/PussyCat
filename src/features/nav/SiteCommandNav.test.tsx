import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SiteCommandNav } from './SiteCommandNav'
import { useAppStore } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'

const c = (site: string, name: string): CommandManifest => ({
  command: `${site}/${name}`, site, name, description: '', access: 'read', browser: false, args: [],
})

beforeEach(() => {
  useAppStore.setState({ commands: [c('12306', 'login'), c('12306', 'orders'), c('xiaohongshu', 'download')], selected: undefined, values: {} })
})

test('站点默认收起:先看见站点行与条数,命令不平铺', () => {
  render(<SiteCommandNav />)
  expect(screen.getByText('12306')).toBeInTheDocument()
  expect(screen.getByTestId('site-row-12306')).toHaveAttribute('aria-expanded', 'false')
  // 断言的是「默认不平铺」这条新语义,而不是把旧的正向断言翻成反向:
  // 下一条用例立刻证明展开后它确实在。
  expect(screen.queryByText('orders')).not.toBeInTheDocument()
})

test('点站点行展开该站命令,再点收起', async () => {
  render(<SiteCommandNav />)
  await userEvent.click(screen.getByTestId('site-row-12306'))
  expect(screen.getByTestId('site-row-12306')).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('orders')).toBeInTheDocument()
  expect(screen.getByText('login')).toBeInTheDocument()
  // 只展开被点的那个:他站仍收起
  expect(screen.queryByText('download')).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId('site-row-12306'))
  expect(screen.queryByText('orders')).not.toBeInTheDocument()
})

test('搜索时自动展开命中站点 —— 搜出来的东西不该再被收起藏住', async () => {
  render(<SiteCommandNav />)
  await userEvent.type(screen.getByTestId('nav-search'), 'download')
  expect(screen.getByText('download')).toBeInTheDocument()
  expect(screen.queryByText('orders')).not.toBeInTheDocument()
})

test('点击命令写入 selected', async () => {
  render(<SiteCommandNav />)
  await userEvent.click(screen.getByTestId('site-row-12306'))
  await userEvent.click(screen.getByText('login'))
  expect(useAppStore.getState().selected?.command).toBe('12306/login')
})

test('选中项所在站点自动展开 —— 否则高亮藏在收起的行里看不见', () => {
  useAppStore.setState({ selected: c('xiaohongshu', 'download') })
  render(<SiteCommandNav />)
  expect(screen.getByTestId('site-row-xiaohongshu')).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('download')).toBeInTheDocument()
  // 对照:无关站点仍收起,证明上面不是"全都展开了"
  expect(screen.getByTestId('site-row-12306')).toHaveAttribute('aria-expanded', 'false')
})

test('导航项不显示 read/write —— 那是命令属性,不是找命令的线索', async () => {
  render(<SiteCommandNav />)
  await userEvent.click(screen.getByTestId('site-row-12306'))
  const row = screen.getByText('login').closest('button')!
  expect(row.textContent).toBe('login')
})

describe('收藏与最近分组', () => {
  const cmds = [c('12306', 'login'), c('12306', 'orders'), c('xiaohongshu', 'download')]
  beforeEach(() => {
    useAppStore.setState({
      commands: cmds, selected: undefined, values: {},
      // acknowledgements:Task 8 给 PreferencesSnapshot 新增的必填字段,此处补空数组(纯类型形状修复,不改本测试语义)
      preferences: { schemaVersion: 1, favoriteSites: [{ site: 'xiaohongshu', order: 0, createdAt: 1 }], favoriteCommands: [{ command: '12306/login', site: '12306', order: 0, createdAt: 2 }], recent: [{ command: 'xiaohongshu/download', at: 3 }], acknowledgements: [] },
      stale: { sites: new Set(), commands: new Set() },
    })
  })

  test('渲染三分组', () => {
    render(<SiteCommandNav />)
    expect(screen.getByTestId('group-recent')).toBeInTheDocument()
    expect(screen.getByTestId('group-fav-sites')).toBeInTheDocument()
    expect(screen.getByTestId('group-fav-commands')).toBeInTheDocument()
  })

  test('点最近项 → selectCommand 载入表单', async () => {
    render(<SiteCommandNav />)
    const recent = screen.getByTestId('group-recent')
    // 最近项现在带站点前缀(见下条用例的理由),定位方式随之改变;断言的主语没变。
    await userEvent.click(within(recent).getByText('小红书 · download'))
    expect(useAppStore.getState().selected?.command).toBe('xiaohongshu/download')
  })

  test('最近使用带站点名 —— 同名命令必须能区分是哪个站的', async () => {
    // 真实场景:whoami / feed / login 在多站重复,最近列表里能同时出现三个 whoami。
    const multi = [c('xiaohongshu', 'whoami'), c('bilibili', 'whoami'), c('github', 'whoami')]
    useAppStore.setState({
      commands: multi,
      preferences: {
        schemaVersion: 1, favoriteSites: [], favoriteCommands: [], acknowledgements: [],
        recent: [{ command: 'xiaohongshu/whoami', at: 3 }, { command: 'bilibili/whoami', at: 2 }, { command: 'github/whoami', at: 1 }],
      },
    })
    render(<SiteCommandNav />)
    const recent = screen.getByTestId('group-recent')
    // 试点四站用中文名;其余站点如实用 site key —— 不给 175 个站点编中文名。
    expect(within(recent).getByText('小红书 · whoami')).toBeInTheDocument()
    expect(within(recent).getByText('B站 · whoami')).toBeInTheDocument()
    expect(within(recent).getByText('github · whoami')).toBeInTheDocument()
    // 反向:光写命令名的旧形态必须不存在,否则三条会长得一模一样
    expect(within(recent).queryByText('whoami')).not.toBeInTheDocument()
  })

  test('三个固定分组各自可折叠', async () => {
    render(<SiteCommandNav />)
    const toggle = screen.getByTestId('group-recent-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')   // 短列表默认展开
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(screen.getByTestId('group-recent')).queryByText(/download/)).not.toBeInTheDocument()
    // 只收起被点的那组:收藏组不受影响
    expect(screen.getByTestId('group-fav-sites-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  test('点常用站点 → 精确站点过滤,他站噪声不出现', async () => {
    // 加一条描述含 "xiaohongshu" 的他站命令:旧 setQ 借道会误命中,精确过滤必须排除
    const noisy = { ...c('other', 'sync'), description: '同步 xiaohongshu 内容' }
    useAppStore.setState({ commands: [...cmds, noisy] })
    render(<SiteCommandNav />)
    await userEvent.click(screen.getByTestId('fav-site-nav-xiaohongshu'))
    expect(screen.getByTestId('site-filter-chip')).toHaveTextContent('xiaohongshu')
    expect((screen.getByTestId('nav-search') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('download')).toBeInTheDocument()      // 本站命令在
    expect(screen.queryByText('sync')).not.toBeInTheDocument()    // 描述噪声命令不在
    expect(screen.queryByText('login')).not.toBeInTheDocument()   // 他站命令不在
    expect(screen.queryByTestId('group-recent')).not.toBeInTheDocument()  // 过滤态不显示三分组
  })

  test('清除 chip → 回全列表;输入搜索 → 退出站点过滤', async () => {
    render(<SiteCommandNav />)
    await userEvent.click(screen.getByTestId('fav-site-nav-xiaohongshu'))
    // 先钉住过滤态:他站**确实不在**。少了这句,下面"回来了"在任何状态下都成立。
    expect(screen.queryByTestId('site-row-12306')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('site-filter-clear'))
    expect(screen.queryByTestId('site-filter-chip')).not.toBeInTheDocument()
    // 站点默认收起后,"12306 回来了"的观察点从命令名移到站点行——主语没变,事实源变了。
    expect(screen.getByTestId('site-row-12306')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('fav-site-nav-xiaohongshu'))
    await userEvent.type(screen.getByTestId('nav-search'), 'or')
    expect(screen.queryByTestId('site-filter-chip')).not.toBeInTheDocument()
  })

  test('失效收藏灰显且禁用', () => {
    useAppStore.setState({ stale: { sites: new Set(), commands: new Set(['12306/login']) } })
    render(<SiteCommandNav />)
    const group = screen.getByTestId('group-fav-commands')
    const btn = within(group).getByText('12306 · login').closest('button')!
    expect(btn).toBeDisabled()
  })

  test('搜索时隐藏分组(q 非空)', async () => {
    render(<SiteCommandNav />)
    await userEvent.type(screen.getByTestId('nav-search'), 'download')
    expect(screen.queryByTestId('group-recent')).not.toBeInTheDocument()
  })
})
