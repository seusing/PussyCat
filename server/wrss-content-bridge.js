export function createWrssContentBridge(bindings, target = globalThis) {
  const {
    articles, articleLoading, sources, sourceLoading, activeMpId, articlePagination,
    sourcePagination, sourceFilter, articleQuery, sourceQuery, articleFilter,
    activeFeed, getArticles, getSubscriptions, nextTick,
  } = bindings
  const cache = new Map()
  const articleErrors = new Map()
  const failedAttempts = new Map()
  const listeners = new Set()
  const requestByView = new Map()
  let view = ''
  let articleRequest = 0
  let sourceRequest = 0
  let disposed = false
  let sourceSignature = ''
  let sourceError = null

  const key = () => view
  const snapshot = () => ({
    rows: [...articles.value], total: articlePagination.value.total || 0,
    page: articlePagination.value.current || 1, limit: articlePagination.value.pageSize || 10,
    query: articleQuery.value || '', filter: articleFilter.value || '',
  })
  const save = () => { if (view && view !== 'sources' && cache.has(key()) && !articleLoading.value && !articleErrors.has(view)) cache.set(key(), snapshot()) }
  const apply = (value) => {
    articles.value = [...value.rows]
    articlePagination.value.total = value.total
    articlePagination.value.current = value.page
    articlePagination.value.pageSize = value.limit
    articleQuery.value = value.query
    articleFilter.value = value.filter
    articleLoading.value = false
  }
  const emit = () => listeners.forEach((listener) => listener(api.getState()))
  const articleParams = () => {
    const params = {
      page: (articlePagination.value.current || 1) - 1,
      pageSize: articlePagination.value.pageSize || 10,
      search: articleQuery.value || '', mp_id: view.startsWith('account:') ? view.slice(8) : '',
    }
    const filter = view === 'favorites' ? 'favorite' : articleFilter.value
    if (filter === 'favorite') params.only_favorite = true
    else if (filter === 'has_content') params.has_content = true
    else if (filter === 'no_content') params.has_content = false
    else if (filter === 'updating' || filter === 'deleted') params.status = filter
    return params
  }
  const normalizeArticle = (item) => ({
    ...item,
    mp_name: item.mp_name || item.account_name || '未知公众号',
    publish_time: item.publish_time || item.create_time || '-',
    url: item.url || 'https://mp.weixin.qq.com/s/' + item.id,
    is_favorite: item.is_favorite === 1 ? 1 : 0,
  })
  const normalizeSource = (item) => ({
    ...item, id: item.id || item.mp_id, name: item.name || item.mp_name,
    avatar: item.avatar || item.mp_cover || '', mp_intro: item.mp_intro || '',
    article_count: item.article_count || 0, status: item.status ?? 1,
  })
  const virtualSources = (rows, total) => [{ id: '', name: '全部', avatar: '/static/logo.svg', mp_intro: '显示所有公众号文章', article_count: total, status: 1 },
    { id: 'MP_WXS_FEATURED_ARTICLES', name: '精选文章', avatar: '/static/logo.svg', mp_intro: '用户手动添加的精选文章', article_count: 0, status: 1 }, ...rows]

  const api = {
    getState: () => ({ view, cache: [...cache.keys()], error: view === 'sources' ? sourceError : articleErrors.get(view) || null, sourcePage: sourcePagination.value.current,
      sources: sources.value.filter((item) => item.id && item.id !== 'MP_WXS_FEATURED_ARTICLES'), sourceLoading: sourceLoading.value,
      sourceTotal: sourcePagination.value.total || 0, sourceQuery: sourceQuery.value || '', articles: [...articles.value], articleLoading: articleLoading.value }),
    selectView(next) {
      const requested = String(next || 'latest')
      save()
      view = requested.startsWith('account:') ? requested : ['latest', 'favorites', 'sources'].includes(requested) ? requested : 'latest'
      if (view.startsWith('account:')) {
        activeMpId.value = view.slice(8)
        activeFeed.value = sources.value.find((item) => item.id === activeMpId.value)
      } else {
        activeMpId.value = ''
        activeFeed.value = { id: '', name: view === 'favorites' ? '我的收藏' : view === 'sources' ? '已订阅公众号' : '最新文章' }
      }
      const cached = cache.get(view)
      if (cached) {
        apply(cached)
        const failed = failedAttempts.get(view)
        if (failed) {
          articlePagination.value.current = failed.page
          articlePagination.value.pageSize = failed.limit
          articleQuery.value = failed.query
          articleFilter.value = failed.filter
        }
      }
      else if (view !== 'sources') {
        articles.value = []
        articlePagination.value.total = 0
        articlePagination.value.current = 1
        articlePagination.value.pageSize = 10
        articleQuery.value = ''
        articleFilter.value = view === 'favorites' ? 'favorite' : ''
        articleLoading.value = true
        void Promise.resolve(nextTick()).then(() => { if (!disposed && view === requested) api.fetchArticles() })
      }
      emit()
      return Promise.resolve(nextTick())
    },
    async fetchArticles() {
      if (disposed || view === 'sources') return
      const currentView = view
      const params = articleParams()
      const requestedFilter = currentView === 'favorites' ? 'favorite' : articleFilter.value
      const signature = JSON.stringify(params)
      const request = ++articleRequest
      requestByView.set(currentView, request)
      articleLoading.value = true
      articleErrors.delete(currentView)
      try {
        const result = await getArticles(params)
        if (disposed || requestByView.get(currentView) !== request) return
        const value = { rows: (result.list || []).map(normalizeArticle), total: result.total || 0,
          page: params.page + 1, limit: params.pageSize, query: params.search, filter: requestedFilter, signature }
        cache.set(currentView, value)
        failedAttempts.delete(currentView)
        if (view === currentView && JSON.stringify(articleParams()) === signature) apply(value)
      } catch (nextError) {
        if (disposed || requestByView.get(currentView) !== request) return
        articleErrors.set(currentView, nextError)
        failedAttempts.set(currentView, { page: params.page + 1, limit: params.pageSize, query: params.search, filter: requestedFilter })
        const previous = cache.get(currentView)
        if (view === currentView && previous) {
          const retry = { page: articlePagination.value.current, limit: articlePagination.value.pageSize, query: articleQuery.value, filter: articleFilter.value }
          articles.value = [...previous.rows]
          articlePagination.value.total = previous.total
          Object.assign(articlePagination.value, { current: retry.page, pageSize: retry.limit })
          articleQuery.value = retry.query
          articleFilter.value = retry.filter
        }
      } finally {
        if (!disposed && view === currentView && requestByView.get(currentView) === request) articleLoading.value = false
        if (!disposed) emit()
      }
    },
    async fetchSources(options = {}) {
      if (disposed) return
      const status = sourceFilter.value === 'active' ? 1 : sourceFilter.value === 'disabled' ? 0 : undefined
      const signature = JSON.stringify([sourceQuery.value || '', status])
      const append = Boolean(options.append && signature === sourceSignature)
      const page = append ? sourcePagination.value.current + 1 : 1
      const request = ++sourceRequest
      if (!append) { sourceSignature = signature; sourcePagination.value.current = 1 }
      sourceLoading.value = true
      try {
        const result = await getSubscriptions({ page: page - 1, pageSize: sourcePagination.value.pageSize, kw: sourceQuery.value || '', status })
        if (disposed || request !== sourceRequest || signature !== sourceSignature) return
        const incoming = (result.list || []).map(normalizeSource).filter((item) => item.id && item.id !== 'MP_WXS_FEATURED_ARTICLES')
        const real = append ? sources.value.filter((item) => item.id && item.id !== 'MP_WXS_FEATURED_ARTICLES') : []
        const byId = new Map(real.map((item) => [item.id, item]))
        incoming.forEach((item) => byId.set(item.id, item))
        sourcePagination.value.current = page
        sourcePagination.value.total = result.total || 0
        sources.value = virtualSources([...byId.values()], result.total || 0)
        sourceError = null
      } catch (nextError) {
        if (!disposed && request === sourceRequest) sourceError = nextError
      } finally {
        if (!disposed && request === sourceRequest) sourceLoading.value = false
        if (!disposed) emit()
      }
    },
    loadMoreSources() {
      const loaded = sources.value.filter((item) => item.id && item.id !== 'MP_WXS_FEATURED_ARTICLES').length
      if (!sourceLoading.value && loaded < (sourcePagination.value.total || 0)) {
        return api.fetchSources({ append: true })
      }
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    dispose() { disposed = true; articleRequest += 1; sourceRequest += 1; listeners.clear(); if (target.__PUSSYCAT_WRSS_BRIDGE__ === api) delete target.__PUSSYCAT_WRSS_BRIDGE__ },
  }
  target.__PUSSYCAT_WRSS_BRIDGE__?.dispose?.()
  target.__PUSSYCAT_WRSS_BRIDGE__ = api
  return api
}
