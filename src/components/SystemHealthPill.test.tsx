import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SystemHealthPill, aggregate, type BridgeHealth } from './SystemHealthPill'
import { useAppStore } from '../store/appStore'

const BASE = 'http://127.0.0.1:1234'
const initialState = useAppStore.getState()
beforeEach(() => { useAppStore.setState(initialState, true) })
afterEach(() => { vi.unstubAllGlobals() })

/** Host 投影后的桥接形状(server/browser-bridge-health.mjs),字段名逐字对齐。 */
function bridge(over: Partial<BridgeHealth> = {}): BridgeHealth {
  return {
    checkedAt: 1, daemon: 'running', daemonVersion: '1.8.6',
    extension: 'connected', extensionVersion: '0.9.1',
    profile: 'ready', profileCount: 1, opencliVersion: '1.8.6',
    retryable: false, reasonCode: 'ok', summary: '浏览器桥接就绪', ...over,
  }
}

/** 三路各有各的端点,按 URL 分派 —— 单一 mockResolvedValue 会让三路互相污染。 */
function routeFetch({ health, bridgeHealth, vk, repair }: {
  health?: unknown
  bridgeHealth?: unknown
  vk?: unknown
  repair?: unknown
} = {}) {
  const spy = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes('/browser-bridge/repair')) return { ok: true, json: async () => repair }
    if (url.includes('/browser-bridge/health')) return { ok: true, json: async () => bridgeHealth ?? bridge() }
    if (url.includes('/vk/v1/health')) return { ok: true, json: async () => vk ?? { status: 'stopped' } }
    return (health as { ok: boolean } | undefined) ?? { ok: true }
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

const connected = () => useAppStore.setState({ mode: 'connected' })

// ─────────────────────────── 聚合口径(纯函数) ───────────────────────────

describe('三路合一的总结论', () => {
  const ok = { demo: false, host: 'online' as const, bridge: bridge(), bridgeState: 'idle' as const, vk: 'ok' }

  test('三路都好 → 全部正常', () => {
    expect(aggregate(ok)).toMatchObject({ tone: 'ok', label: '基础连接正常', canRepair: false })
  })

  test('Host 挂了压过一切 —— 它挂了别的都不用谈', () => {
    // 这正是原来那颗灯说谎的反面:绝不能因为桥接是绿的就报正常。
    const v = aggregate({ ...ok, host: 'offline', bridge: bridge() })
    expect(v).toMatchObject({ tone: 'down', label: '爪爪服务离线' })
    expect(v.canRepair).toBe(false)   // Host 都不可达,修不了
  })

  test('浏览器扩展没连上时不许报正常 —— 这是本次要修的原始症状', () => {
    const v = aggregate({ ...ok, bridge: bridge({ extension: 'disconnected', reasonCode: 'extension-disconnected' }) })
    expect(v).toMatchObject({ tone: 'warn', label: '浏览器扩展未连接', canRepair: true })
  })

  test('视频解析真失败才算故障且不提供浏览器修复', () => {
    expect(aggregate({ ...ok, vk: 'failed' })).toMatchObject({ tone: 'warn', label: '视频解析异常', canRepair: false })
  })

  test('视频解析的 not-configured / stopped / starting 是空闲态,不是故障', () => {
    // sidecar 按需启动,把"没在跑"当异常会让这颗灯长期挂黄,黄久了等于没有灯。
    for (const status of ['not-configured', 'stopped', 'starting']) {
      expect(aggregate({ ...ok, vk: status }).label).toBe('基础连接正常')
    }
  })

  test('视频解析状态未知不冒充正常且不提供浏览器修复', () => {
    expect(aggregate({ ...ok, vk: undefined })).toMatchObject({ tone: 'warn', label: '视频解析状态未知', canRepair: false })
    expect(aggregate({ ...ok, vk: 'future-status' })).toMatchObject({ tone: 'warn', label: '视频解析状态未知', canRepair: false })
  })

  test('演示模式如实标演示,不冒充健康', () => {
    expect(aggregate({ ...ok, demo: true })).toMatchObject({ tone: 'warn', label: '演示模式' })
  })
})

// ─────────────────────────── 第一路:Host ───────────────────────────

test('demo 模式显示演示模式,且不发任何 ping', () => {
  const spy = routeFetch()
  render(<SystemHealthPill baseUrl={BASE} />)
  expect(screen.getByTestId('health-label')).toHaveTextContent('演示模式')
  expect(spy).not.toHaveBeenCalled()
})

test('connected 初态「检查中…」—— 首 ping 落定前不得显示已连接', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))   // 永不落定
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  expect(screen.getByTestId('health-label')).toHaveTextContent('检查中…')
})

test('ping ok → 基础连接正常;ping fail → 爪爪服务离线', async () => {
  routeFetch()
  connected()
  const { unmount } = render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('基础连接正常'))
  unmount()

  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('爪爪服务离线'))
})

test('ping 返回非 2xx(ok:false)→ 离线', async () => {
  routeFetch({ health: { ok: false } })
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('爪爪服务离线'))
})

test('慢旧响应不倒灌(世代 latest-wins)', async () => {
  vi.useFakeTimers()
  try {
    let resolveSlow!: (v: { ok: boolean }) => void
    const slow = new Promise<{ ok: boolean }>((r) => { resolveSlow = r })
    let first = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/browser-bridge/health')) return { ok: true, json: async () => bridge() }
      if (url.includes('/vk/v1/health')) return { ok: true, json: async () => ({ status: 'ok' }) }
      if (first) { first = false; return slow }
      return { ok: true }
    }))
    connected()
    render(<SystemHealthPill baseUrl={BASE} />)
    await act(async () => { vi.advanceTimersByTime(5000) })   // 第 2 发发出并落定 online
    await act(async () => {})
    expect(screen.getByTestId('health-label')).toHaveTextContent('基础连接正常')
    resolveSlow({ ok: false })                                // 旧响应姗姗来迟
    await act(async () => {})
    expect(screen.getByTestId('health-label')).toHaveTextContent('基础连接正常')   // 未被倒灌
  } finally { vi.useRealTimers() }
})

test('ping 超过 2s 无响应 → abort 后转离线', async () => {
  vi.useFakeTimers()
  try {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/browser-bridge/health') || url.includes('/vk/v1/health')) return new Promise(() => {})
      return new Promise((_res, rej) => {
        (init?.signal as AbortSignal)?.addEventListener('abort', () => rej(new Error('AbortError')))
      })
    }))
    connected()
    render(<SystemHealthPill baseUrl={BASE} />)
    expect(screen.getByTestId('health-label')).toHaveTextContent('检查中…')
    await act(async () => { vi.advanceTimersByTime(2100) })   // 越过 PING_TIMEOUT_MS
    expect(screen.getByTestId('health-label')).toHaveTextContent('爪爪服务离线')
  } finally { vi.useRealTimers() }
})

test('卸载 abort 在途 ping', () => {
  let captured: AbortSignal | undefined
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/health') && !url.includes('bridge') && !url.includes('vk')) captured = init?.signal as AbortSignal
    return new Promise(() => {})
  }))
  connected()
  const { unmount } = render(<SystemHealthPill baseUrl={BASE} />)
  expect(captured?.aborted).toBe(false)
  unmount()
  expect(captured?.aborted).toBe(true)
})

test('a11y:role=status + aria-live=polite', () => {
  routeFetch()
  const pill = render(<SystemHealthPill baseUrl={BASE} />).getByTestId('health-pill')
  expect(pill).toHaveAttribute('role', 'status')
  expect(pill).toHaveAttribute('aria-live', 'polite')
})

// ─────────────────────────── 第二路:浏览器桥 ───────────────────────────

test('就绪时只给结论,不内联 daemon/扩展/profile 及版本明细', async () => {
  routeFetch()
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('基础连接正常'))
  const text = screen.getByTestId('health-pill').textContent ?? ''
  expect(text).not.toContain('1.8.6')
  expect(text).not.toContain('daemon')
})

test('点击状态结论才展开三路明细与最后检查时间', async () => {
  routeFetch()
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('基础连接正常'))

  expect(screen.queryByTestId('health-details')).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId('health-details-toggle'))

  const details = screen.getByTestId('health-details')
  expect(details).toHaveTextContent('爪爪服务')
  expect(details).toHaveTextContent('浏览器连接')
  expect(details).toHaveTextContent('视频解析')
  expect(details).toHaveTextContent('最后检查')
  expect(details).toHaveTextContent('1.8.6')
})

test('视频解析未配置在详情中如实显示，不写成按需启动', async () => {
  routeFetch({ vk: { status: 'not-configured' } })
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('基础连接正常'))
  await userEvent.click(screen.getByTestId('health-details-toggle'))
  expect(screen.getByTestId('health-details')).toHaveTextContent('视频解析未配置')
})

test('扩展未连接时展示 Host 给的失败原因,不是前端自己编一句', async () => {
  routeFetch({ bridgeHealth: bridge({ extension: 'disconnected', reasonCode: 'extension-disconnected', summary: 'daemon 在运行,但 Chrome 扩展未连上' }) })
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('浏览器扩展未连接'))
})

test('桥接探测本身失败 → 桥接状态未知(与「Host 说没就绪」区分开)', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/browser-bridge/health')) return { ok: false, status: 500, json: async () => ({}) }
    if (url.includes('/vk/v1/health')) return { ok: true, json: async () => ({ status: 'ok' }) }
    return { ok: true }
  }))
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('桥接状态未知'))
})

test('窗口重获焦点时自动重探 —— 你去开了浏览器,切回来就该是新鲜的', async () => {
  routeFetch({ bridgeHealth: bridge({ extension: 'disconnected', reasonCode: 'extension-disconnected' }) })
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('浏览器扩展未连接'))

  routeFetch()                                                    // 用户把浏览器打开了
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)      // 越过去重窗口
  act(() => { window.dispatchEvent(new Event('focus')) })

  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('基础连接正常'))
})

test('去重窗口内的连发只探一次 —— focus 与 visibilitychange 常常连着各来一发', async () => {
  const spy = routeFetch()
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('基础连接正常'))
  const before = spy.mock.calls.filter((c) => String(c[0]).includes('/browser-bridge/health')).length

  window.dispatchEvent(new Event('focus'))
  document.dispatchEvent(new Event('visibilitychange'))
  await new Promise((r) => setTimeout(r, 10))

  const after = spy.mock.calls.filter((c) => String(c[0]).includes('/browser-bridge/health')).length
  expect(after).toBe(before)
})

test('全部正常时按钮为重新检查状态,仅 GET 健康检查且不发 repair POST', async () => {
  const spy = routeFetch()
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('基础连接正常'))
  expect(screen.queryByTestId('health-repair')).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId('health-details-toggle'))
  const button = screen.getByTestId('health-repair')
  expect(button).toHaveTextContent('重新检查状态')
  await userEvent.click(button)
  await waitFor(() => expect(spy.mock.calls.filter((c) => String(c[0]).includes('/browser-bridge/health')).length).toBeGreaterThanOrEqual(2))
  expect(spy.mock.calls.some((c) => String(c[0]).includes('/browser-bridge/repair'))).toBe(false)
})

test('检测中不显示修复动作', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  expect(screen.queryByTestId('health-repair')).not.toBeInTheDocument()
})

// ─────────────────────────── 检测并修复 ───────────────────────────

test('点「检测并修复」打 POST,并采信 Host 复检后的 health', async () => {
  const spy = routeFetch({
    bridgeHealth: bridge({ daemon: 'stopped', reasonCode: 'daemon-stopped', summary: 'daemon 未运行' }),
    repair: { steps: [{ action: 'daemon-restart', outcome: 'done' }], health: bridge(), repaired: true },
  })
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('浏览器服务未运行'))
  await userEvent.click(screen.getByTestId('health-details-toggle'))
  expect(screen.getByTestId('health-repair')).toHaveTextContent('修复浏览器连接')

  await userEvent.click(screen.getByTestId('health-repair'))

  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('基础连接正常'))
  const call = spy.mock.calls.find((c) => String(c[0]).includes('/browser-bridge/repair'))
  expect(call?.[0]).toBe(`${BASE}/browser-bridge/repair`)
  expect((call?.[1] as RequestInit)?.method).toBe('POST')
})

test('修不好时把 Host 给的下一步照原样显示 —— 不把"修不了"说成"再试一次"', async () => {
  routeFetch({
    bridgeHealth: bridge({ extension: 'disconnected', reasonCode: 'extension-disconnected' }),
    repair: {
      steps: [{ action: 'launch-browser', outcome: 'done' }],
      health: bridge({ extension: 'disconnected', reasonCode: 'extension-disconnected' }),
      repaired: false,
      nextStep: '在 Chrome 里打开装有 OpenCLI 扩展的窗口,并确认该扩展处于启用状态。',
    },
  })
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('浏览器扩展未连接'))
  await userEvent.click(screen.getByTestId('health-details-toggle'))

  await userEvent.click(screen.getByTestId('health-repair'))

  await waitFor(() => expect(screen.getByTestId('health-next-step')).toHaveTextContent('OpenCLI 扩展'))
  expect(screen.getByTestId('health-label')).toHaveTextContent('浏览器扩展未连接')   // 没修好就别改结论
})

test('Host 离线时修复按钮禁用 —— 请求根本送不到,不给假希望', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
  connected()
  render(<SystemHealthPill baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('爪爪服务离线'))
  expect(screen.queryByTestId('health-repair')).not.toBeInTheDocument()
})

test('演示模式不给修复按钮 —— 没有真 Host 可修', () => {
  routeFetch()
  render(<SystemHealthPill baseUrl={BASE} />)
  expect(screen.queryByTestId('health-repair')).not.toBeInTheDocument()
})

// ─────────────────────────── 浮层的收起时机 ───────────────────────────

describe('浮层收起', () => {
  test('点别处就收起 —— 浮层压在页面上方，不收起会挡住下面的东西', async () => {
    connected()
    routeFetch()
    render(<div><SystemHealthPill baseUrl={BASE} /><button type="button">别处</button></div>)

    await userEvent.click(screen.getByTestId('health-details-toggle'))
    expect(screen.getByTestId('health-details')).toBeInTheDocument()

    await userEvent.click(screen.getByText('别处'))
    expect(screen.queryByTestId('health-details')).not.toBeInTheDocument()
  })

  test('点浮层自己不收起 —— 里面有按钮要点', async () => {
    connected()
    routeFetch({ bridgeHealth: bridge({ daemon: 'stopped', reasonCode: 'daemon-stopped', summary: '浏览器服务未运行' }) })
    render(<SystemHealthPill baseUrl={BASE} />)

    await userEvent.click(screen.getByTestId('health-details-toggle'))
    await waitFor(() => expect(screen.getByTestId('health-details')).toBeInTheDocument())

    await userEvent.click(screen.getByText('连接状态'))
    expect(screen.getByTestId('health-details')).toBeInTheDocument()
  })

  test('按 Esc 收起', async () => {
    connected()
    routeFetch()
    render(<SystemHealthPill baseUrl={BASE} />)

    await userEvent.click(screen.getByTestId('health-details-toggle'))
    expect(screen.getByTestId('health-details')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('health-details')).not.toBeInTheDocument()
  })

  test('修好了自动收起 —— 事办完了，浮层没理由继续占屏幕', async () => {
    connected()
    routeFetch({
      bridgeHealth: bridge({ daemon: 'stopped', reasonCode: 'daemon-stopped', summary: '浏览器服务未运行' }),
      repair: { steps: [], repaired: true, health: bridge() },
    })
    render(<SystemHealthPill baseUrl={BASE} />)

    await userEvent.click(screen.getByTestId('health-details-toggle'))
    await waitFor(() => expect(screen.getByTestId('health-repair')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('health-repair'))

    await waitFor(() => expect(screen.queryByTestId('health-details')).not.toBeInTheDocument())
    // 灯本身转绿 —— 这就是反馈,不必靠浮层停留来告诉用户。
    await waitFor(() => expect(screen.getByTestId('health-label')).toHaveTextContent('基础连接正常'))
  })

  test('没修好就留着 —— nextStep 正是用户接下来要读的东西', async () => {
    connected()
    const stopped = bridge({ daemon: 'stopped', reasonCode: 'daemon-stopped', summary: '浏览器服务未运行' })
    routeFetch({
      bridgeHealth: stopped,
      repair: { steps: [], repaired: false, health: stopped, nextStep: '在 Chrome 里打开装有 OpenCLI 扩展的窗口。' },
    })
    render(<SystemHealthPill baseUrl={BASE} />)

    await userEvent.click(screen.getByTestId('health-details-toggle'))
    await waitFor(() => expect(screen.getByTestId('health-repair')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('health-repair'))

    await waitFor(() => expect(screen.getByTestId('health-next-step')).toHaveTextContent('OpenCLI 扩展'))
    expect(screen.getByTestId('health-details')).toBeInTheDocument()
  })
})
