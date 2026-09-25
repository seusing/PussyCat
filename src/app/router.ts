export type AppRoute =
  | { page: 'progress' }
  | { page: 'organize' }
  | { page: 'spaces' }
  | { page: 'space'; spaceId: string }
  | { page: 'ledger' }
  | { page: 'mine' }
  | { page: 'sharing' }

export function resolveRoute(pathname: string): AppRoute {
  if (pathname === '/organize') return { page: 'organize' }
  if (pathname === '/spaces') return { page: 'spaces' }
  const spaceMatch = pathname.match(/^\/spaces\/([^/]+)$/)
  if (spaceMatch) return { page: 'space', spaceId: decodeURIComponent(spaceMatch[1]) }
  if (pathname === '/ledger') return { page: 'ledger' }
  if (pathname === '/mine') return { page: 'mine' }
  if (pathname === '/sharing') return { page: 'sharing' }
  return { page: 'progress' }
}

export function navigate(path: string): void {
  window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
