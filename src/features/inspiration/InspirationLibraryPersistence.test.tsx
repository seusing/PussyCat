import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveTextFileAs } from '../../lib/saveTextFile'
import { fakeInspirationPersistence } from '../../testing/inspirationPersistence'
import { addInspirationFolder, addInspirationItem, connectInspirationLibrary, loadInspirationLibrary } from './inspirationLibrary'
import { InspirationLibraryPanel } from './InspirationLibraryPanel'

vi.mock('../../lib/saveTextFile', () => ({ saveTextFileAs: vi.fn() }))

beforeEach(() => {
  vi.restoreAllMocks()
})

const note = (id: string, patch: Record<string, unknown> = {}) => ({
  id, title: `笔记 ${id}`, content: `内容 ${id}`, kind: 'note', format: 'md', folderId: null, createdAt: 1, updatedAt: 1, ...patch,
})

describe('灵感库的读取与保存状态', () => {
  it('读取完成前显示读取中，且不提供写入入口', async () => {
    const persistence = fakeInspirationPersistence(null)
    let release: (value: { exists: boolean; library: unknown }) => void = () => {}
    persistence.load.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    connectInspirationLibrary(persistence)
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    expect(screen.getByTestId('inspiration-library-loading')).toHaveTextContent('读取中…')
    expect(screen.queryByRole('button', { name: /新建笔记/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('inspiration-library-empty')).not.toBeInTheDocument()

    await act(async () => { release({ exists: false, library: null }) })
    expect(await screen.findByTestId('inspiration-library-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('inspiration-library-loading')).not.toBeInTheDocument()
  })

  it('读取失败时给出错误和重试，重试成功后显示宿主上的内容', async () => {
    const persistence = fakeInspirationPersistence({ version: 1, folders: [], items: [note('host-1', { title: '宿主上的笔记' })] })
    persistence.loadError = new Error('无法连接爪爪本地服务，请稍后重试')
    connectInspirationLibrary(persistence)
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    const failure = await screen.findByTestId('inspiration-library-load-error')
    expect(failure).toHaveTextContent('读取灵感库失败：无法连接爪爪本地服务，请稍后重试')
    expect(screen.queryByRole('button', { name: /新建笔记/ })).not.toBeInTheDocument()

    persistence.loadError = null
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByTestId('inspiration-item-host-1')).toHaveTextContent('宿主上的笔记')
    expect(screen.queryByTestId('inspiration-library-load-error')).not.toBeInTheDocument()
  })

  it('写宿主失败时显示持续提示且保留修改，下次保存成功后提示消失', async () => {
    const persistence = fakeInspirationPersistence({ version: 1, folders: [], items: [] })
    connectInspirationLibrary(persistence)
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /新建笔记/ }))
    persistence.saveError = new Error('HTTP 500')
    await userEvent.click(await screen.findByRole('button', { name: '返回目录' }))

    const banner = await screen.findByTestId('inspiration-library-save-error', undefined, { timeout: 3_000 })
    expect(banner).toHaveTextContent('灵感库没能保存到本机文件，稍后会自动重试')
    expect(loadInspirationLibrary().items).toHaveLength(1)

    persistence.saveError = null
    await userEvent.click(screen.getAllByRole('button', { name: /新建笔记/ })[0])
    await waitFor(() => expect(screen.queryByTestId('inspiration-library-save-error')).not.toBeInTheDocument(), { timeout: 3_000 })
    expect(persistence.save.mock.calls.at(-1)?.[0].items).toHaveLength(2)
  })
})

describe('灵感库导出全部与导入', () => {
  const backupFile = (library: unknown) => new File(
    [JSON.stringify({ backupVersion: 1, exportedAt: '2026-10-09T00:00:00.000Z', library })],
    'backup.json',
    { type: 'application/json' },
  )

  it('导出全部把整个库写成带版本字段的备份文件', async () => {
    addInspirationFolder('文件夹')
    addInspirationItem({ title: '要备份的', content: '正文', kind: 'note', format: 'md', folderId: null })
    vi.mocked(saveTextFileAs).mockResolvedValue(true)
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: '导出全部' }))

    expect(saveTextFileAs).toHaveBeenCalledTimes(1)
    const [fileName, content] = vi.mocked(saveTextFileAs).mock.calls[0]
    expect(fileName).toMatch(/^爪爪灵感库-\d{8}\.json$/)
    expect(JSON.parse(content)).toMatchObject({ backupVersion: 1, library: loadInspirationLibrary() })
    expect(await screen.findByText(`已导出“${fileName}”`)).toBeInTheDocument()
  })

  it('导入按 id 合并，提示导入和跳过的条数，重复导入全部跳过', async () => {
    const existing = addInspirationItem({ title: '笔记 a', content: '现有内容', kind: 'note', format: 'md', folderId: null })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)
    const file = backupFile({
      version: 1,
      folders: [{ id: 'f1', name: '备份文件夹', createdAt: 1, parentId: null }],
      items: [note(existing.id, { content: '备份里的内容' }), note('b', { folderId: 'f1' })],
    })

    await userEvent.upload(screen.getByTestId('inspiration-import-input'), file)

    expect(await screen.findByText('导入 2 条，跳过 1 条重复')).toBeInTheDocument()
    const merged = loadInspirationLibrary()
    expect(merged.items.map((entry) => [entry.id, entry.content])).toEqual([[existing.id, '现有内容'], ['b', '内容 b']])
    expect(merged.folders.map((entry) => entry.id)).toEqual(['f1'])
    expect(screen.getByTestId('inspiration-folder-item-f1')).toBeInTheDocument()

    await userEvent.upload(screen.getByTestId('inspiration-import-input'), file)
    expect(await screen.findByText('导入 0 条，跳过 3 条重复')).toBeInTheDocument()
    expect(loadInspirationLibrary().items).toHaveLength(2)
  })

  it('空库时可以直接从备份文件恢复', async () => {
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)
    expect(screen.getByRole('button', { name: /导入备份/ })).toBeInTheDocument()

    await userEvent.upload(screen.getByTestId('inspiration-import-input'), backupFile({ version: 1, folders: [], items: [note('a'), note('b')] }))

    expect(await screen.findByText('导入 2 条，跳过 0 条重复')).toBeInTheDocument()
    expect(screen.queryByTestId('inspiration-library-empty')).not.toBeInTheDocument()
    expect(screen.getByTestId('inspiration-item-a')).toBeInTheDocument()
  })

  it('文件格式不对时提示原因，库保持不变', async () => {
    addInspirationItem({ title: '原有', content: '', kind: 'note', format: 'md', folderId: null })
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.upload(screen.getByTestId('inspiration-import-input'), new File(['{"hello":"world"}'], 'other.json', { type: 'application/json' }))
    expect(await screen.findByText('这不是爪爪灵感库的备份文件')).toBeInTheDocument()

    await userEvent.upload(screen.getByTestId('inspiration-import-input'), new File(['不是 json'], 'broken.json', { type: 'application/json' }))
    expect(await screen.findByText('这不是有效的 JSON 文件')).toBeInTheDocument()
    expect(loadInspirationLibrary().items.map((entry) => entry.title)).toEqual(['原有'])
  })

  it('备份里有格式无效的条目时一并提示', async () => {
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.upload(screen.getByTestId('inspiration-import-input'), backupFile({ version: 1, folders: [], items: [note('a'), { id: 'bad' }] }))

    expect(await screen.findByText('导入 1 条，跳过 0 条重复')).toBeInTheDocument()
    expect(screen.getByText('另有 1 条格式无效，已忽略')).toBeInTheDocument()
  })
})
