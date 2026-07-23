import { render, screen } from '@testing-library/react'
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
