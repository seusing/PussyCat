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

test('渲染站点分组与命令', () => {
  render(<SiteCommandNav />)
  expect(screen.getByText('12306')).toBeInTheDocument()
  expect(screen.getByText('download')).toBeInTheDocument()
})

test('搜索过滤命令', async () => {
  render(<SiteCommandNav />)
  await userEvent.type(screen.getByTestId('nav-search'), 'download')
  expect(screen.getByText('download')).toBeInTheDocument()
  expect(screen.queryByText('orders')).not.toBeInTheDocument()
})

test('点击命令写入 selected', async () => {
  render(<SiteCommandNav />)
  await userEvent.click(screen.getByText('login'))
  expect(useAppStore.getState().selected?.command).toBe('12306/login')
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
    await userEvent.click(within(recent).getByText('download'))
    expect(useAppStore.getState().selected?.command).toBe('xiaohongshu/download')
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
    await userEvent.click(screen.getByTestId('site-filter-clear'))
    expect(screen.queryByTestId('site-filter-chip')).not.toBeInTheDocument()
    expect(screen.getByText('login')).toBeInTheDocument()          // 12306 回来了
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
