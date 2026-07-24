import { render, screen, waitFor } from '@testing-library/react'
import { HealthPill } from './HealthPill'
import { useAppStore } from '../store/appStore'

const initialState = useAppStore.getState()
beforeEach(() => { useAppStore.setState(initialState, true) })  // true = replace，每个用例前恢复初始态

test('demo 模式不发起 /health 探活，直接显示演示模式', () => {
  const fetchMock = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal('fetch', fetchMock)
  useAppStore.setState({ mode: 'demo' })

  render(<HealthPill />)

  expect(screen.getByTestId('health-pill')).toHaveTextContent('演示模式')
  expect(fetchMock).not.toHaveBeenCalled()
})

test('connected 模式：/health 200 → 显示已连接', async () => {
  const fetchMock = vi.fn((_url: string) => Promise.resolve({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  useAppStore.setState({ mode: 'connected' })

  render(<HealthPill />)

  await waitFor(() => expect(screen.getByTestId('health-pill')).toHaveTextContent('已连接'))
  expect(fetchMock.mock.calls[0][0]).toMatch(/\/health$/)
})

test('connected 模式：/health 请求失败（网络不可达）→ 显示 Host 离线，不再假绿', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))
  useAppStore.setState({ mode: 'connected' })

  render(<HealthPill />)

  await waitFor(() => expect(screen.getByTestId('health-pill')).toHaveTextContent('Host 离线'))
  expect(screen.getByTestId('health-pill')).not.toHaveTextContent('已连接')
})

test('connected 模式：/health 返回非 2xx → 显示 Host 离线', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })))
  useAppStore.setState({ mode: 'connected' })

  render(<HealthPill />)

  await waitFor(() => expect(screen.getByTestId('health-pill')).toHaveTextContent('Host 离线'))
})
