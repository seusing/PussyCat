import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addInspirationItem, loadInspirationLibrary } from './inspirationLibrary'
import { InspirationLibraryPanel } from './InspirationLibraryPanel'

vi.mock('../../lib/saveTextFile', () => ({ saveTextFileAs: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
})

describe('灵感库', () => {
  it('空状态可以跳转到灵感来源', async () => {
    const onOpenSources = vi.fn()
    render(<InspirationLibraryPanel onOpenSources={onOpenSources} />)

    expect(screen.getByTestId('inspiration-library-empty')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /去找灵感/ }))
    expect(onOpenSources).toHaveBeenCalledTimes(1)
  })

  it('新建笔记、编辑内容并保存到本地库', async () => {
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: /新建笔记/ }))
    const title = await screen.findByTestId('inspiration-title-input')
    const content = screen.getByTestId('inspiration-content-input')
    await userEvent.clear(title)
    await userEvent.type(title, '我的灵感')
    await userEvent.clear(content)
    await userEvent.type(content, '## 一个想法')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '选择文件格式' }), 'txt')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    const saved = loadInspirationLibrary()
    expect(saved.items).toHaveLength(1)
    expect(saved.items[0]).toMatchObject({ title: '我的灵感', content: '## 一个想法', format: 'txt', kind: 'note' })
    expect(screen.getByTestId(`inspiration-item-${saved.items[0].id}`)).toHaveTextContent('我的灵感')
  })

  it('只创建文件夹时也会离开空状态并保留文件夹', async () => {
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: /新建文件夹/ }))
    await userEvent.type(screen.getByRole('textbox', { name: '文件夹名称' }), '视频选题')
    await userEvent.click(screen.getByRole('button', { name: /创建/ }))

    expect(screen.queryByTestId('inspiration-library-empty')).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: '灵感文件夹' })).toHaveTextContent('视频选题')
    expect(loadInspirationLibrary().folders.map((folder) => folder.name)).toEqual(['视频选题'])
  })

  it('显示视频解析和非网址来源，并支持按关键词搜索', async () => {
    const video = addInspirationItem({
      title: '视频结果',
      content: '# 重点内容',
      kind: 'video',
      format: 'md',
      folderId: null,
      source: '视频解析任务',
    })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    expect(screen.getByTestId(`inspiration-item-${video.id}`)).toHaveTextContent('视频解析')
    await userEvent.click(screen.getByTestId(`inspiration-item-${video.id}`))
    expect(screen.getByText('来源：视频解析任务')).toBeInTheDocument()
    await userEvent.type(screen.getByTestId('nav-search'), '不存在')
    expect(screen.getByText('没有匹配的灵感')).toBeInTheDocument()
  })
})
