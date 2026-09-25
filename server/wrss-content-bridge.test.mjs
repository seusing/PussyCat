import { describe, expect, it, vi } from 'vitest'
import { createWrssContentBridge } from './wrss-content-bridge.js'

const ref = (value) => ({ value })
function fixture(overrides = {}) {
  const bindings = {
    articles: ref([]), articleLoading: ref(false), sources: ref([]), sourceLoading: ref(false), activeMpId: ref(''),
    articlePagination: ref({ current: 1, pageSize: 10, total: 0 }), sourcePagination: ref({ current: 1, pageSize: 10, total: 0 }),
    sourceFilter: ref('all'), articleQuery: ref(''), sourceQuery: ref(''), articleFilter: ref(''), activeFeed: ref(),
    getArticles: vi.fn(async () => ({ list: [], total: 0 })), getSubscriptions: vi.fn(async () => ({ list: [], total: 0 })), nextTick: vi.fn(async () => {}),
    ...overrides,
  }
  return { bindings, bridge: createWrssContentBridge(bindings, {}) }
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

describe('createWrssContentBridge', () => {
  it('loads latest, favorites, and account views with Vue pagination fields', async () => {
    const { bindings, bridge } = fixture({ getArticles: vi.fn(async (params) => ({ list: [{ id: params.mp_id || (params.only_favorite ? 'fav' : 'latest') }], total: 1 })) })
    bridge.selectView('latest'); await vi.waitFor(() => expect(bindings.getArticles).toHaveBeenCalledTimes(1))
    expect(bindings.getArticles).toHaveBeenLastCalledWith(expect.objectContaining({ page: 0, pageSize: 10, mp_id: '' }))
    bridge.selectView('favorites'); await vi.waitFor(() => expect(bindings.getArticles).toHaveBeenCalledTimes(2))
    expect(bindings.getArticles).toHaveBeenLastCalledWith(expect.objectContaining({ only_favorite: true, mp_id: '' }))
    bridge.selectView('account:mp-7'); await vi.waitFor(() => expect(bindings.getArticles).toHaveBeenCalledTimes(3))
    expect(bindings.getArticles).toHaveBeenLastCalledWith(expect.objectContaining({ mp_id: 'mp-7' }))
    bindings.articlePagination.value = { current: 3, pageSize: 20, total: 1 }; bindings.articleQuery.value = 'saved'; await bridge.fetchArticles()
    bridge.selectView('latest'); const calls = bindings.getArticles.mock.calls.length
    bridge.selectView('account:mp-7')
    expect(bindings.getArticles).toHaveBeenCalledTimes(calls)
    expect(bindings.articlePagination.value).toMatchObject({ current: 3, pageSize: 20 })
    expect(bindings.articleQuery.value).toBe('saved')
  })

  it('isolates slow and stale same-view responses and preserves successful rows on retryable failure', async () => {
    const first = deferred(), second = deferred(), third = deferred()
    const getArticles = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
    const { bindings, bridge } = fixture({ getArticles })
    bridge.selectView('latest'); await vi.waitFor(() => expect(getArticles).toHaveBeenCalledOnce())
    bindings.articleQuery.value = 'new'; const newer = bridge.fetchArticles()
    second.resolve({ list: [{ id: 'new' }], total: 1 }); await newer
    first.resolve({ list: [{ id: 'old' }], total: 1 }); await first.promise
    expect(bindings.articles.value.map((item) => item.id)).toEqual(['new'])
    const retry = bridge.fetchArticles(); third.reject(new Error('offline')); await retry
    expect(bindings.articles.value.map((item) => item.id)).toEqual(['new'])
    expect(bridge.getState().error.message).toBe('offline')
  })

  it('loads only the next source page, deduplicates, and rejects stale query appends', async () => {
    const stale = deferred()
    const getSubscriptions = vi.fn()
      .mockResolvedValueOnce({ list: [{ mp_id: 'a' }, { mp_id: 'b' }], total: 4 })
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ list: [{ mp_id: 'z' }], total: 1 })
    const { bindings, bridge } = fixture({ getSubscriptions })
    await bridge.fetchSources()
    expect(bindings.getArticles).not.toHaveBeenCalled()
    const append = bridge.loadMoreSources()
    expect(getSubscriptions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 10 }))
    bindings.sourceQuery.value = 'z'; const reset = bridge.fetchSources()
    stale.resolve({ list: [{ mp_id: 'c' }], total: 4 }); await append; await reset
    expect(bindings.sources.value.slice(0, 2).map((item) => item.id)).toEqual(['', 'MP_WXS_FEATURED_ARTICLES'])
    expect(bindings.sources.value.filter((item) => item.id && item.id !== 'MP_WXS_FEATURED_ARTICLES').map((item) => item.id)).toEqual(['z'])
  })

  it('ignores inflight work after dispose', async () => {
    const pending = deferred()
    const { bindings, bridge } = fixture({ getArticles: vi.fn(() => pending.promise) })
    bridge.selectView('latest'); await vi.waitFor(() => expect(bindings.articleLoading.value).toBe(true))
    bridge.dispose(); pending.resolve({ list: [{ id: 'late' }], total: 1 }); await pending.promise
    expect(bindings.articles.value).toEqual([])
  })

  it('retries an uncached failed view and keeps a late other-view failure out of current state', async () => {
    const failedLatest = deferred()
    const getArticles = vi.fn().mockReturnValueOnce(failedLatest.promise).mockResolvedValueOnce({ list: [{ id: 'fav' }], total: 1 }).mockResolvedValueOnce({ list: [{ id: 'latest-ok' }], total: 1 })
    const { bindings, bridge } = fixture({ getArticles })
    bridge.selectView('latest'); await vi.waitFor(() => expect(getArticles).toHaveBeenCalledOnce())
    bridge.selectView('favorites'); await vi.waitFor(() => expect(getArticles).toHaveBeenCalledTimes(2))
    failedLatest.reject(new Error('late latest failure'))
    await vi.waitFor(() => expect(bindings.articles.value.map((item) => item.id)).toEqual(['fav']))
    expect(bridge.getState().error).toBeNull()
    bridge.selectView('latest')
    await vi.waitFor(() => expect(getArticles).toHaveBeenCalledTimes(3))
    expect(bindings.articles.value.map((item) => item.id)).toEqual(['latest-ok'])
  })

  it('retries the same source page after an append failure', async () => {
    const getSubscriptions = vi.fn().mockResolvedValueOnce({ list: [{ mp_id: 'a' }], total: 3 }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ list: [{ mp_id: 'b' }], total: 3 })
    const { bindings, bridge } = fixture({ getSubscriptions })
    await bridge.fetchSources()
    await bridge.loadMoreSources()
    expect(bindings.sourcePagination.value.current).toBe(1)
    await bridge.loadMoreSources()
    expect(getSubscriptions.mock.calls[1][0].page).toBe(1)
    expect(getSubscriptions.mock.calls[2][0].page).toBe(1)
    expect(bindings.sourcePagination.value.current).toBe(2)
    expect(bindings.sources.value.filter((item) => item.id && item.id !== 'MP_WXS_FEATURED_ARTICLES').map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('keeps failed retry inputs separate from successful rows and errors per view', async () => {
    const getArticles = vi.fn()
      .mockResolvedValueOnce({ list: [{ id: 'latest-old' }], total: 1 })
      .mockRejectedValueOnce(new Error('latest failed'))
      .mockResolvedValueOnce({ list: [{ id: 'fav' }], total: 1 })
      .mockResolvedValueOnce({ list: [{ id: 'latest-new' }], total: 1 })
    const { bindings, bridge } = fixture({ getArticles })
    bridge.selectView('latest'); await vi.waitFor(() => expect(bindings.articles.value[0]?.id).toBe('latest-old'))
    bindings.articleQuery.value = 'new query'; bindings.articlePagination.value.current = 2
    await bridge.fetchArticles()
    expect(bindings.articles.value[0].id).toBe('latest-old')
    bridge.selectView('favorites'); await vi.waitFor(() => expect(bindings.articles.value[0]?.id).toBe('fav'))
    expect(bridge.getState().error).toBeNull()
    bridge.selectView('latest')
    expect(bindings.articles.value[0].id).toBe('latest-old')
    expect(bindings.articleQuery.value).toBe('new query')
    expect(bindings.articlePagination.value.current).toBe(2)
    expect(bridge.getState().error.message).toBe('latest failed')
    await bridge.fetchArticles()
    expect(getArticles).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, search: 'new query' }))
    expect(bindings.articles.value[0].id).toBe('latest-new')
  })
})
