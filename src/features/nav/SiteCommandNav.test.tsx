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
      preferences: { schemaVersion: 1, favoriteSites: [{ site: 'xiaohongshu', order: 0, createdAt: 1 }], favoriteCommands: [{ command: '12306/login', site: '12306', order: 0, createdAt: 2 }], recent: [{ command: 'xiaohongshu/download', at: 3 }] },
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

  test('点常用站点 → setQ 进该站点目录', async () => {
    render(<SiteCommandNav />)
    await userEvent.click(screen.getByTestId('fav-site-nav-xiaohongshu'))
    expect((screen.getByTestId('nav-search') as HTMLInputElement).value).toBe('xiaohongshu')
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
