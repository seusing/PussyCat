import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InspirationPanel } from './InspirationPanel'
import { FisheyeCommandList } from './FisheyeCommandList'
import { useAppStore } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'

const snapshot = JSON.parse(readFileSync(resolve(process.cwd(), 'public/catalog.snapshot.json'), 'utf8')) as { commands: CommandManifest[] }
const catalog = snapshot.commands.filter((command) => ['twitter', 'xiaohongshu', 'youtube', 'bilibili'].includes(command.site))
const initialState = useAppStore.getState()

const renderPanel = () => render(<InspirationPanel onRun={() => {}} onCancel={() => {}} onRerun={() => {}} />)

// 轮播里点侧边卡只会把它滑到居中,等滑动结束再点一次才进入站点。
async function clickSite(site: string) {
  const card = screen.getByTestId(`site-row-${site}`)
  if (card.getAttribute('data-selected') !== 'true') {
    fireEvent.click(card)
    await waitFor(() => expect(screen.getByTestId('site-carousel')).toHaveAttribute('data-sliding', 'false'), { timeout: 3000 })
  }
  fireEvent.click(card)
}

async function openSite(site: string) {
  useAppStore.setState({ commands: catalog, selected: undefined })
  renderPanel()
  await clickSite(site)
}

const rowKeys = () => screen.queryAllByTestId(/^command-row-/).map((row) => row.getAttribute('data-testid')!.replace('command-row-', ''))

beforeEach(() => { useAppStore.setState(initialState, true) })

describe('站点命令列表:中文名与分组', () => {
  it('小红书:先是「常用」再是「读取」,「写入」默认折叠并注明会改动账号内容或登录状态', async () => {
    await openSite('xiaohongshu')

    expect(screen.getByTestId('command-group-common')).toHaveTextContent('常用')
    expect(screen.getByTestId('command-group-read')).toHaveTextContent('读取')
    const write = screen.getByTestId('command-group-write')
    expect(write).toHaveTextContent('写入')
    expect(write).toHaveTextContent('会改动你的账号内容或登录状态')
    expect(within(write).getByRole('button')).toHaveAttribute('aria-expanded', 'false')

    const keys = rowKeys()
    expect(keys.slice(0, 6)).toEqual([
      'xiaohongshu/search', 'xiaohongshu/note', 'xiaohongshu/comments',
      'xiaohongshu/user-posts', 'xiaohongshu/feed', 'xiaohongshu/saved',
    ])
    expect(keys).toContain('xiaohongshu/drafts')                  // 其余只读命令在「读取」里
    expect(keys).not.toContain('xiaohongshu/publish')             // 写入命令还没展开
    expect(keys).not.toContain('xiaohongshu/delete-note')
    expect(keys).not.toContain('xiaohongshu/collections')         // 旧命令仍然隐藏
    // 「常用」里的命令不在「读取」里重复出现
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('展开「写入」后看到写入命令,再点收起', async () => {
    await openSite('xiaohongshu')
    const toggle = within(screen.getByTestId('command-group-write')).getByRole('button')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(rowKeys()).toEqual(expect.arrayContaining(['xiaohongshu/publish', 'xiaohongshu/delete-note']))

    fireEvent.click(toggle)
    expect(rowKeys()).not.toContain('xiaohongshu/publish')
  })

  it('每一行主标签是中文短名,英文命令名是次要小字', async () => {
    await openSite('xiaohongshu')

    const row = screen.getByTestId('command-row-xiaohongshu/search')
    expect(within(row).getByText('搜索笔记').tagName).toBe('STRONG')
    expect(within(row).getByText('search')).toHaveClass('fisheye-command-name')
    expect(row).toHaveTextContent('读取')
  })

  it('X:常用里是搜索、时间线这类只读命令', async () => {
    await openSite('x')

    expect(rowKeys().slice(0, 6)).toEqual([
      'twitter/search', 'twitter/timeline', 'twitter/tweets',
      'twitter/thread', 'twitter/bookmarks', 'twitter/profile',
    ])
    expect(screen.getByTestId('command-row-twitter/timeline')).toHaveTextContent('首页时间线')
  })

  it('搜索同时匹配中文名、英文名和中文说明', async () => {
    await openSite('xiaohongshu')
    const search = screen.getByTestId('nav-search')

    fireEvent.change(search, { target: { value: '博主主页' } })               // 中文名
    expect(rowKeys()).toEqual(['xiaohongshu/user'])

    fireEvent.change(search, { target: { value: 'user-posts' } })             // 英文名
    expect(rowKeys()).toEqual(['xiaohongshu/user-posts'])

    fireEvent.change(search, { target: { value: '楼中楼' } })                 // 中文说明
    expect(rowKeys()).toEqual(['xiaohongshu/comments'])
  })

  it('搜索只命中写入命令时,「写入」组自动展开而不是显示"没有匹配"', async () => {
    await openSite('xiaohongshu')

    fireEvent.change(screen.getByTestId('nav-search'), { target: { value: '删除笔记' } })

    expect(rowKeys()).toEqual(['xiaohongshu/delete-note'])
    expect(screen.queryByRole('status', { name: '没有匹配的命令' })).not.toBeInTheDocument()
  })

  it('换一个站点进来,「写入」又是折叠的', async () => {
    await openSite('xiaohongshu')
    fireEvent.click(within(screen.getByTestId('command-group-write')).getByRole('button'))
    expect(rowKeys()).toContain('xiaohongshu/publish')

    fireEvent.click(screen.getByRole('button', { name: '返回站点' }))
    await clickSite('youtube')

    expect(within(screen.getByTestId('command-group-write')).getByRole('button')).toHaveAttribute('aria-expanded', 'false')
    expect(rowKeys()).not.toContain('youtube/like')
  })

  it('没有中文名的命令照常显示英文名,不重复出现次要小字', () => {
    const plain: CommandManifest = {
      command: 'github/trending', site: 'github', name: 'trending', description: 'List trending repositories',
      access: 'read', browser: false, args: [],
    }
    render(<FisheyeCommandList commands={[plain]} onSubmit={() => {}} />)

    const row = screen.getByTestId('command-row-github/trending')
    expect(within(row).getByText('trending').tagName).toBe('STRONG')
    expect(row.querySelector('.fisheye-command-name')).toBeNull()
  })

  it('命令详情页顶部是中文短名,英文名作副标题', async () => {
    await openSite('xiaohongshu')
    // 第一行默认展开,再点一下它的标题行就进入详情
    await userEvent.click(within(screen.getByTestId('command-row-xiaohongshu/search')).getByRole('button', { name: /搜索笔记/ }))

    expect(screen.getByTestId('command-title')).toHaveTextContent('搜索笔记')
    expect(screen.getByTestId('command-subtitle')).toHaveTextContent('search')
  })
})
