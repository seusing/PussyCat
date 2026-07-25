import { render, screen, waitFor, act } from '@testing-library/react'
import { HealthPill } from './HealthPill'
import { useAppStore } from '../store/appStore'

const initialState = useAppStore.getState()
beforeEach(() => { useAppStore.setState(initialState, true) })

test('demo 模式显示演示模式', () => {
  render(<HealthPill />)
  expect(screen.getByTestId('health-pill')).toHaveTextContent('演示模式')
})

test('connected 初态「检查中…」,首 ping 落定前不得显示已连接(消灭乐观默认)', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))   // 永不落定
  useAppStore.setState({ mode: 'connected' })
  render(<HealthPill />)
  expect(screen.getByTestId('health-pill')).toHaveTextContent('检查中…')
})

test('ping ok → 已连接;ping fail → Host 离线', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
  useAppStore.setState({ mode: 'connected' })
  const { unmount } = render(<HealthPill />)
  await waitFor(() => expect(screen.getByTestId('health-pill')).toHaveTextContent('已连接'))
  unmount()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
  render(<HealthPill />)
  await waitFor(() => expect(screen.getByTestId('health-pill')).toHaveTextContent('Host 离线'))
})

test('慢旧响应不倒灌(世代 latest-wins)', async () => {
  vi.useFakeTimers()
  try {
    let resolveSlow!: (v: { ok: boolean }) => void
    const slow = new Promise<{ ok: boolean }>((r) => { resolveSlow = r })
    const fetchMock = vi.fn()
      .mockReturnValueOnce(slow)                                  // 第 1 发:悬挂(将失败)
      .mockResolvedValue({ ok: true })                            // 之后:成功
    vi.stubGlobal('fetch', fetchMock)
    useAppStore.setState({ mode: 'connected' })
    render(<HealthPill />)
    await act(async () => { vi.advanceTimersByTime(5000) })       // 第 2 发发出并落定 online
    await act(async () => {})                                     // flush 微任务
    expect(screen.getByTestId('health-pill')).toHaveTextContent('已连接')
    resolveSlow({ ok: false })                                    // 旧响应姗姗来迟
    await act(async () => {})
    expect(screen.getByTestId('health-pill')).toHaveTextContent('已连接')   // 未被倒灌
  } finally { vi.useRealTimers() }
})

test('a11y:role=status + aria-live=polite', () => {
  render(<HealthPill />)
  const pill = screen.getByTestId('health-pill')
  expect(pill).toHaveAttribute('role', 'status')
  expect(pill).toHaveAttribute('aria-live', 'polite')
})

test('ping 返回非 2xx(ok:false) → Host 离线(终审 I-1 护栏恢复)', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
  useAppStore.setState({ mode: 'connected' })
  render(<HealthPill />)
  await waitFor(() => expect(screen.getByTestId('health-pill')).toHaveTextContent('Host 离线'))
})

test('demo 模式不发 ping(终审 I-1 护栏恢复)', () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  render(<HealthPill />)   // mode 默认 demo
  expect(fetchMock).not.toHaveBeenCalled()
})

test('卸载 abort 在途 ping(spec §8 明列,终审 I-1)', () => {
  let captured: AbortSignal | undefined
  vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => {
    captured = init?.signal as AbortSignal
    return new Promise(() => {})
  }))
  useAppStore.setState({ mode: 'connected' })
  const { unmount } = render(<HealthPill />)
  expect(captured?.aborted).toBe(false)
  unmount()
  expect(captured?.aborted).toBe(true)
})
