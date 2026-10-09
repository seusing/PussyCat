import { vi } from 'vitest'
import type { InspirationPersistence } from '../features/inspiration/inspirationLibrary'

// 宿主灵感库文件的内存桩:remote 为 null 表示宿主上还没有文件。
export function fakeInspirationPersistence(remote: unknown = null) {
  const state = { remote, loadError: null as Error | null, saveError: null as Error | null }
  const load = vi.fn<InspirationPersistence['load']>(async () => {
    if (state.loadError) throw state.loadError
    return state.remote === null ? { exists: false, library: null } : { exists: true, library: state.remote }
  })
  const save = vi.fn<InspirationPersistence['save']>(async (library) => {
    if (state.saveError) throw state.saveError
    state.remote = library
  })
  return Object.assign(state, { load, save })
}
