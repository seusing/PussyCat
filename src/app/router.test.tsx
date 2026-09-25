import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AppShell } from './AppShell'
import { resolveRoute } from './router'

afterEach(() => {
  window.history.replaceState(null, '', '/progress')
})

describe('route shell', () => {
  it('resolves supported paths and sends unknown paths to progress', () => {
    expect(resolveRoute('/progress')).toEqual({ page: 'progress' })
    expect(resolveRoute('/organize')).toEqual({ page: 'organize' })
    expect(resolveRoute('/spaces')).toEqual({ page: 'spaces' })
    expect(resolveRoute('/spaces/alpha')).toEqual({ page: 'space', spaceId: 'alpha' })
    expect(resolveRoute('/ledger')).toEqual({ page: 'ledger' })
    expect(resolveRoute('/mine')).toEqual({ page: 'mine' })
    expect(resolveRoute('/sharing')).toEqual({ page: 'sharing' })
    expect(resolveRoute('/not-found')).toEqual({ page: 'progress' })
  })

  it('tracks pushState navigation and popstate with one active page root', () => {
    window.history.replaceState(null, '', '/progress')
    render(<AppShell />)

    window.history.pushState(null, '', '/spaces/alpha')
    fireEvent(window, new PopStateEvent('popstate'))
    expect(screen.getByRole('heading', { name: '空间 alpha' })).toBeInTheDocument()
    expect(document.querySelectorAll('[data-page-root]')).toHaveLength(1)

    window.history.replaceState(null, '', '/progress')
    fireEvent(window, new PopStateEvent('popstate'))
    expect(screen.getByRole('heading', { name: 'progress' })).toBeInTheDocument()
    expect(document.querySelectorAll('[data-page-root]')).toHaveLength(1)
  })
})
