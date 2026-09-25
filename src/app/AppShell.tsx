import { useEffect, useState } from 'react'
import { resolveRoute, type AppRoute } from './router'

function RoutePage({ route }: { route: AppRoute }) {
  const title = route.page === 'space' ? `空间 ${route.spaceId}` : route.page
  return (
    <main data-page-root={route.page}>
      <h1>{title}</h1>
      <p>页面迁移支架，业务内容尚未迁移。</p>
    </main>
  )
}

export function AppShell() {
  const [pathname, setPathname] = useState(window.location.pathname)

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const route = resolveRoute(pathname)
  return <RoutePage route={route} />
}
