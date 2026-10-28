import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OpencliReleaseStatus } from './OpencliReleaseStatus'
import { useOpencliUpdate } from './useOpencliUpdate'
import type { OpencliRelease, OpencliUpdateJob } from '../host/opencliRelease'

// motion 的偏好只在首次读取时缓存,所以单独成文件并直接替身 useReducedMotion。
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => true,
}))

const BASE = 'http://127.0.0.1:43117'
const release: OpencliRelease = {
  checkedAt: Date.now(), current: '1.8.6', latest: '1.8.8', updateAvailable: true,
  releaseUrl: 'https://github.com/jackwener/opencli/releases/tag/v1.8.8', active: '1.8.6', bundled: '1.8.6', activeInstalledAt: null,
}
const jobOf = (over: Partial<OpencliUpdateJob> = {}): OpencliUpdateJob => ({
  id: 'job-1', version: '1.8.8', state: 'running', stage: 'install', receivedBytes: 0, totalBytes: 13_000_000, percent: 70,
  warnings: [], startedAt: 1, finishedAt: null, ...over,
})
const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
const elapse = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => { vi.useRealTimers() })

function Harness() {
  const update = useOpencliUpdate(BASE, () => {}, true)
  return <OpencliReleaseStatus release={{ state: 'idle', data: release }} onCheck={() => {}} update={update} />
}

function renderUpdating(polled: OpencliUpdateJob) {
  let queries = 0
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const path = url.slice(BASE.length)
    if (path === '/opencli/update' && init?.method === 'POST') return json({ job: jobOf() })
    if (path === '/opencli/update') return json({ job: (queries += 1) === 1 ? null : polled })
    if (path === '/opencli/update/cancel') return json({ job: jobOf({ state: 'cancelled' }) })
    return new Promise<Response>(() => {})
  }))
  render(<Harness />)
  fireEvent.click(screen.getByTestId('update-opencli'))
  return elapse(0)
}

test('缩减动效下卡片即时出现,进度区不做高度动画而直接按状态收放', async () => {
  await renderUpdating(jobOf({ state: 'succeeded', stage: 'done', percent: 100 }))

  expect(screen.getByTestId('opencli-update-card')).toBeInTheDocument()
  expect(screen.getByTestId('opencli-update-card-progress')).toHaveAttribute('data-open', 'true')
  expect(screen.getByTestId('opencli-update-card-progress').style.height).toBe('12px')

  await elapse(300)
  expect(screen.getByTestId('opencli-update-card-badge')).toBeInTheDocument()
  expect(screen.getByTestId('opencli-update-card-progress')).toHaveAttribute('data-open', 'false')
  await waitFor(() => expect(screen.getByTestId('opencli-update-card-progress').style.height).toBe('0px'))
})

test('缩减动效下取消:卡片没有退场动画,当场摘掉', async () => {
  await renderUpdating(jobOf())
  fireEvent.click(screen.getByRole('button', { name: '取消更新' }))
  await elapse(0)

  expect(screen.queryByTestId('opencli-update-card')).not.toBeInTheDocument()
  expect(screen.getByTestId('update-opencli')).toBeInTheDocument()
})
