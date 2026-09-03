import { useEffect, useMemo, useState, type FormEvent, type Ref } from 'react'
import {
  BookOpen, Check, Download, Eye, FilePlus2, FileText, Folder, FolderOpen,
  FolderPlus, Pencil, Search, Trash2, Video, X,
} from 'lucide-react'
import Markdown from 'react-markdown'
import { saveTextFileAs } from '../../lib/saveTextFile'
import {
  INSPIRATION_LIBRARY_EVENT,
  addInspirationFolder,
  addInspirationItem,
  inspirationKindLabel,
  loadInspirationLibrary,
  saveInspirationLibrary,
  type InspirationItem,
  type InspirationLibrary,
} from './inspirationLibrary'
import './InspirationLibraryPanel.css'

type FolderFilter = 'all' | 'root' | string
type ViewMode = 'edit' | 'read'

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function fileNameFor(item: InspirationItem): string {
  const base = item.title.trim().replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || '灵感笔记'
  return `${base}.${item.format}`
}

function kindIcon(item: InspirationItem) {
  if (item.kind === 'video') return <Video size={15} aria-hidden="true" />
  if (item.kind === 'source') return <BookOpen size={15} aria-hidden="true" />
  return <FileText size={15} aria-hidden="true" />
}

function isWebSource(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function updateItem(library: InspirationLibrary, itemId: string, patch: Partial<InspirationItem>): InspirationLibrary {
  return {
    ...library,
    items: library.items.map((item) => item.id === itemId ? { ...item, ...patch, updatedAt: Date.now() } : item),
  }
}

export function InspirationLibraryPanel({ onOpenSources, searchRef }: { onOpenSources: () => void; searchRef?: Ref<HTMLInputElement> }) {
  const [library, setLibrary] = useState<InspirationLibrary>(() => loadInspirationLibrary())
  const [folderFilter, setFolderFilter] = useState<FolderFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [folderDraft, setFolderDraft] = useState('')
  const [showFolderForm, setShowFolderForm] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [contentDraft, setContentDraft] = useState('')
  const [formatDraft, setFormatDraft] = useState<'md' | 'txt'>('md')
  const [itemFolderDraft, setItemFolderDraft] = useState<string>('')
  const [viewMode, setViewMode] = useState<ViewMode>('edit')
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    const reload = () => setLibrary(loadInspirationLibrary())
    window.addEventListener(INSPIRATION_LIBRARY_EVENT, reload)
    return () => window.removeEventListener(INSPIRATION_LIBRARY_EVENT, reload)
  }, [])

  const selectedItem = library.items.find((item) => item.id === selectedId) ?? null

  useEffect(() => {
    if (!selectedItem) {
      const first = library.items[0]
      if (first) setSelectedId(first.id)
      return
    }
    setTitleDraft(selectedItem.title)
    setContentDraft(selectedItem.content)
    setFormatDraft(selectedItem.format)
    setItemFolderDraft(selectedItem.folderId ?? '')
  }, [selectedItem?.id, library.items.length])

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return library.items.filter((item) => {
      const inFolder = folderFilter === 'all'
        || (folderFilter === 'root' ? item.folderId === null : item.folderId === folderFilter)
      if (!inFolder) return false
      if (!normalized) return true
      return [item.title, item.content, item.source ?? ''].some((value) => value.toLocaleLowerCase().includes(normalized))
    }).sort((a, b) => b.updatedAt - a.updatedAt)
  }, [folderFilter, library.items, query])

  const persist = (next: InspirationLibrary, successMessage?: string): boolean => {
    if (!saveInspirationLibrary(next)) {
      setStatus('保存失败，请检查本地存储空间')
      return false
    }
    setLibrary(next)
    if (successMessage) setStatus(successMessage)
    return true
  }

  const createNote = () => {
    const item = addInspirationItem({
      title: '未命名灵感',
      content: '# 未命名灵感\n\n',
      kind: 'note',
      format: 'md',
      folderId: folderFilter === 'all' || folderFilter === 'root' ? null : folderFilter,
    })
    if (!item) {
      setStatus('创建失败，请检查本地存储空间')
      return
    }
    setLibrary(loadInspirationLibrary())
    setSelectedId(item.id)
    setViewMode('edit')
    setStatus(null)
  }

  const createFolder = (event: FormEvent) => {
    event.preventDefault()
    const folder = addInspirationFolder(folderDraft)
    if (!folder) return
    setLibrary(loadInspirationLibrary())
    setFolderFilter(folder.id)
    setFolderDraft('')
    setShowFolderForm(false)
    setStatus('文件夹已创建')
  }

  const saveSelected = () => {
    if (!selectedItem) return
    const next = updateItem(library, selectedItem.id, {
      title: titleDraft.trim() || '未命名灵感',
      content: contentDraft,
      format: formatDraft,
      folderId: itemFolderDraft || null,
    })
    persist(next, '已保存')
  }

  const removeSelected = () => {
    if (!selectedItem || !window.confirm(`删除「${selectedItem.title}」？`)) return
    const next = { ...library, items: library.items.filter((item) => item.id !== selectedItem.id) }
    if (!persist(next, '已删除')) return
    setSelectedId(next.items[0]?.id ?? null)
  }

  const exportSelected = async () => {
    if (!selectedItem) return
    try {
      const saved = await saveTextFileAs(fileNameFor({ ...selectedItem, title: titleDraft, format: formatDraft }), contentDraft)
      if (saved) setStatus('文件已导出')
    } catch {
      setStatus('导出失败')
    }
  }

  const removeFolder = (folderId: string) => {
    const folder = library.folders.find((item) => item.id === folderId)
    if (!folder || !window.confirm(`删除文件夹「${folder.name}」？其中的内容会保留在根目录。`)) return
    const next: InspirationLibrary = {
      ...library,
      folders: library.folders.filter((item) => item.id !== folderId),
      items: library.items.map((item) => item.folderId === folderId ? { ...item, folderId: null, updatedAt: Date.now() } : item),
    }
    if (!persist(next, '文件夹已删除')) return
    setFolderFilter('all')
  }

  const hasItems = library.items.length > 0
  const hasContent = hasItems || library.folders.length > 0

  return (
    <div data-testid="inspiration-library" className="inspiration-library-page">
      <header className="inspiration-library-header">
        <div className="inspiration-library-heading">
          <span>PERSONAL LIBRARY</span>
          <h1>灵感库</h1>
          <p>把值得回看的视频、来源和想法放在一个地方。</p>
        </div>
        <div className="inspiration-library-header-actions">
          <div className="inspiration-library-switch" role="group" aria-label="灵感工作区">
            <button type="button" data-testid="inspiration-library-tab" aria-pressed="true" title="查看灵感库">
              <FolderOpen size={15} aria-hidden="true" />灵感库
            </button>
            <button type="button" data-testid="inspiration-sources-tab" aria-pressed="false" onClick={onOpenSources} title="获取新的灵感">
              <BookOpen size={15} aria-hidden="true" />灵感来源
            </button>
          </div>
          <label className="inspiration-library-search">
            <Search size={16} aria-hidden="true" />
            <input ref={searchRef} data-testid="nav-search" data-library-search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索灵感" aria-label="搜索灵感" />
            {query && <button type="button" aria-label="清除搜索" title="清除搜索" onClick={() => setQuery('')}><X size={14} /></button>}
          </label>
        </div>
      </header>

      {!hasContent ? (
        <section data-testid="inspiration-library-empty" className="inspiration-library-empty">
          <div className="inspiration-library-empty-icon"><FolderOpen size={30} aria-hidden="true" /></div>
          <h2>还没有灵感</h2>
          <p>先去获取灵感，或写下一个想法。视频解析结果也可以直接收进这里。</p>
          <div className="inspiration-library-empty-actions">
            <button type="button" className="inspiration-library-primary-action" onClick={createNote}><FilePlus2 size={16} aria-hidden="true" />新建笔记</button>
            <button type="button" className="inspiration-library-secondary-action" onClick={() => setShowFolderForm((value) => !value)}><FolderPlus size={16} aria-hidden="true" />新建文件夹</button>
            <button type="button" className="inspiration-library-secondary-action" onClick={onOpenSources}><BookOpen size={16} aria-hidden="true" />去找灵感</button>
          </div>
          {showFolderForm && (
            <form className="inspiration-library-empty-folder-form" onSubmit={createFolder}>
              <input autoFocus value={folderDraft} onChange={(event) => setFolderDraft(event.target.value)} placeholder="文件夹名称" aria-label="文件夹名称" />
              <button type="submit" className="inspiration-library-primary-action"><Check size={14} aria-hidden="true" />创建</button>
            </form>
          )}
        </section>
      ) : (
        <div className="inspiration-library-workspace">
          <aside className="inspiration-library-sidebar scroll-fade" aria-label="灵感文件夹">
            <div className="inspiration-library-sidebar-heading">
              <strong>文件夹</strong>
              <button type="button" aria-label="新建文件夹" title="新建文件夹" onClick={() => setShowFolderForm((value) => !value)}><FolderPlus size={16} /></button>
            </div>
            {showFolderForm && (
              <form className="inspiration-library-folder-form" onSubmit={createFolder}>
                <input autoFocus value={folderDraft} onChange={(event) => setFolderDraft(event.target.value)} placeholder="文件夹名称" aria-label="文件夹名称" />
                <button type="submit" aria-label="确认新建文件夹" title="确认"><Check size={14} /></button>
              </form>
            )}
            <nav className="inspiration-library-folder-list">
              <button type="button" className={folderFilter === 'all' ? 'is-active' : ''} onClick={() => setFolderFilter('all')}><FolderOpen size={15} />全部灵感<span>{library.items.length}</span></button>
              <button type="button" className={folderFilter === 'root' ? 'is-active' : ''} onClick={() => setFolderFilter('root')}><Folder size={15} />未分类<span>{library.items.filter((item) => item.folderId === null).length}</span></button>
              {library.folders.map((folder) => (
                <div className="inspiration-library-folder-row" key={folder.id}>
                  <button type="button" className={folderFilter === folder.id ? 'is-active' : ''} onClick={() => setFolderFilter(folder.id)}><Folder size={15} />{folder.name}<span>{library.items.filter((item) => item.folderId === folder.id).length}</span></button>
                  <button type="button" aria-label={`删除文件夹 ${folder.name}`} title="删除文件夹" onClick={() => removeFolder(folder.id)}><Trash2 size={13} /></button>
                </div>
              ))}
            </nav>
          </aside>

          <section className="inspiration-library-list-pane" aria-label="灵感列表">
            <div className="inspiration-library-pane-heading">
              <div><strong>{folderFilter === 'all' ? '全部灵感' : folderFilter === 'root' ? '未分类' : library.folders.find((folder) => folder.id === folderFilter)?.name}</strong><span>{visibleItems.length} 条</span></div>
              <button type="button" className="inspiration-library-primary-action" onClick={createNote}><FilePlus2 size={15} aria-hidden="true" />新建笔记</button>
            </div>
            <div className="inspiration-library-items scroll-fade">
              {visibleItems.length === 0 ? <p className="inspiration-library-no-results">没有匹配的灵感</p> : visibleItems.map((item) => (
                <button type="button" key={item.id} data-testid={`inspiration-item-${item.id}`} className={`inspiration-library-item${item.id === selectedId ? ' is-selected' : ''}`} onClick={() => setSelectedId(item.id)}>
                  <span className={`inspiration-library-item-icon is-${item.kind}`}>{kindIcon(item)}</span>
                  <span className="inspiration-library-item-copy"><strong>{item.title || '未命名灵感'}</strong><small>{inspirationKindLabel(item.kind)} · {formatDate(item.updatedAt)}</small><em>{item.content.replace(/[#*_`\n]/g, ' ').trim() || '空白笔记'}</em></span>
                </button>
              ))}
            </div>
          </section>

          <section className="inspiration-library-editor" aria-label="灵感内容">
            {selectedItem ? (
              <>
                <div className="inspiration-library-editor-heading">
                  <div className="inspiration-library-editor-title"><Pencil size={15} aria-hidden="true" /><input data-testid="inspiration-title-input" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} aria-label="灵感标题" /></div>
                  <div className="inspiration-library-editor-actions">
                    <div className="inspiration-library-view-switch" role="group" aria-label="内容视图">
                      <button type="button" aria-pressed={viewMode === 'edit'} onClick={() => setViewMode('edit')} title="编辑"><Pencil size={14} /></button>
                      <button type="button" aria-pressed={viewMode === 'read'} onClick={() => setViewMode('read')} title="阅读"><Eye size={14} /></button>
                    </div>
                    <button type="button" aria-label="导出文件" title="导出文件" onClick={() => { void exportSelected() }}><Download size={15} /></button>
                    <button type="button" aria-label="删除灵感" title="删除灵感" onClick={removeSelected}><Trash2 size={15} /></button>
                  </div>
                </div>
                <div className="inspiration-library-editor-meta">
                  <span>{inspirationKindLabel(selectedItem.kind)}</span>
                  {selectedItem.source && (isWebSource(selectedItem.source)
                    ? <a href={selectedItem.source} target="_blank" rel="noreferrer">打开来源</a>
                    : <span>来源：{selectedItem.source}</span>)}
                  <label>文件夹
                    <select value={itemFolderDraft} onChange={(event) => setItemFolderDraft(event.target.value)} aria-label="选择文件夹">
                      <option value="">未分类</option>
                      {library.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                    </select>
                  </label>
                  <label>格式
                    <select value={formatDraft} onChange={(event) => setFormatDraft(event.target.value as 'md' | 'txt')} aria-label="选择文件格式"><option value="md">Markdown</option><option value="txt">纯文本</option></select>
                  </label>
                </div>
                {viewMode === 'edit' ? (
                  <textarea data-testid="inspiration-content-input" value={contentDraft} onChange={(event) => setContentDraft(event.target.value)} aria-label="灵感内容" placeholder="写下你的想法…" />
                ) : (
                  <div data-testid="inspiration-content-preview" className="inspiration-library-preview scroll-fade"><Markdown>{contentDraft || '*还没有内容*'}</Markdown></div>
                )}
                <div className="inspiration-library-editor-footer">
                  <span>{status ?? `更新于 ${formatDate(selectedItem.updatedAt)}`}</span>
                  <button type="button" className="inspiration-library-primary-action" onClick={saveSelected}><Check size={15} aria-hidden="true" />保存</button>
                </div>
              </>
            ) : (
              <div className="inspiration-library-editor-empty"><FileText size={22} /><span>选择一条灵感开始阅读或编辑</span></div>
            )}
          </section>
        </div>
      )}

      {hasContent && <div className="inspiration-library-mobile-add"><button type="button" className="inspiration-library-primary-action" onClick={createNote}><FilePlus2 size={15} />新建笔记</button></div>}
    </div>
  )
}
