import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { OpencliReleaseStatus, type ReleaseState } from './OpencliReleaseStatus'
import { useOpencliUpdate } from './useOpencliUpdate'
import type { OpencliRelease, OpencliUpdateJob } from '../host/opencliRelease'

const BASE = 'http://127.0.0.1:43117'

type Responder = () => Promise<Response>
const reply = (status: number, body: unknown): Responder => () => Promise.resolve({ ok: status < 400, status, json: async () => body } as Response)

const releaseOf = (over: Partial<OpencliRelease> = {}): OpencliRelease => ({
  checkedAt: Date.now(), current: '1.8.6', latest: '1.8.8', updateAvailable: true,
  releaseUrl: 'https://github.com/jackwener/opencli/releases/tag/v1.8.8', active: '1.8.6', bundled: '1.8.6', activeInstalledAt: null, ...over,
})
const jobOf = (over: Partial<OpencliUpdateJob> = {}): OpencliUpdateJob => ({
  id: 'job-1', version: '1.8.8', state: 'running', stage: 'resolve', receivedBytes: 0, totalBytes: null, percent: 0,
  warnings: [], startedAt: 1, finishedAt: null, ...over,
})
const running = (over: Partial<OpencliUpdateJob>) => reply(200, { job: jobOf(over) })
// 挂载时的那次查询(Host 里没有进行中的任务)。
const idle = reply(200, { job: null })

// 按「METHOD /path」分派;同一路由的应答依次取用、用完停在最后一个;没登记的请求永不 settle。
function stubHost(routes: Record<string, Responder[]>) {
  const calls: Array<{ key: string; body?: string }> = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.slice(BASE.length)}`
    calls.push({ key, body: typeof init?.body === 'string' ? init.body : undefined })
    const queue = routes[key]
    if (!queue) return new Promise<Response>(() => {})
    return queue[Math.min(calls.filter((call) => call.key === key).length - 1, queue.length - 1)]()
  }))
  return {
    count: (key: string) => calls.filter((call) => call.key === key).length,
    lastBody: (key: string) => JSON.parse(calls.filter((call) => call.key === key).at(-1)?.body ?? 'null') as unknown,
  }
}

// 更新状态在 App 层持有,这里用一个最小的宿主组件代替 App。
function Harness({ release, onCheck, enabled, commandCount }: { release: ReleaseState; onCheck: () => void; enabled: boolean; commandCount?: number }) {
  const update = useOpencliUpdate(BASE, onCheck, enabled)
  return <OpencliReleaseStatus release={release} onCheck={onCheck} update={update} commandCount={commandCount} />
}
const renderRelease = (release: ReleaseState, { enabled = true, commandCount }: { enabled?: boolean; commandCount?: number } = {}) => {
  const onCheck = vi.fn()
  const view = render(<Harness release={release} onCheck={onCheck} enabled={enabled} commandCount={commandCount} />)
  return { onCheck, ...view }
}
const renderStatus = (data: OpencliRelease = releaseOf(), enabled = true) => renderRelease({ state: 'idle', data }, { enabled })
// 点开顶栏的版本文字,拿到小面板。
const openPanel = () => {
  fireEvent.click(screen.getByTestId('opencli-release'))
  return screen.getByRole('dialog', { name: 'OpenCLI 版本' })
}

// 轮询次数:GET /opencli/update 的第 1 次是挂载时的查询,其余才是轮询。
const polls = (host: ReturnType<typeof stubHost>) => host.count('GET /opencli/update') - 1
// 假时钟下推进时间并冲刷随后的 promise
const elapse = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
// 推进一轮轮询(300ms)
const poll = () => elapse(300)

const card = () => screen.getByTestId('opencli-update-card')
const meta = () => screen.getByTestId('opencli-update-card-meta')
// 读屏播报区:只放阶段级文字,百分比交给进度条的 aria-valuenow。
const announce = () => screen.getByTestId('opencli-update-card-announce')
const fillOf = () => screen.getByTestId('opencli-update-card-fill')
// 退场动画靠真实帧推进,假时钟推不动它,所以按真实时间轮询到卡片摘掉。
const cardGone = async () => {
  for (let i = 0; i < 40 && screen.queryByTestId('opencli-update-card'); i += 1) {
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50) }) })
  }
  expect(screen.queryByTestId('opencli-update-card')).not.toBeInTheDocument()
}
const panelGone = async () => {
  for (let i = 0; i < 40 && screen.queryByTestId('opencli-release-panel'); i += 1) {
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50) }) })
  }
  expect(screen.queryByTestId('opencli-release-panel')).not.toBeInTheDocument()
}
const startUpdate = async (data?: OpencliRelease) => {
  const view = renderStatus(data)
  fireEvent.click(screen.getByTestId('update-opencli'))
  await elapse(0)
  return view
}

// 只替身 setTimeout:jsdom 的 requestAnimationFrame 内部用 setInterval 驱动,替身化后用例结束时若还有动画在跑,
// 之后的 rAF 就停了,卡片的退场动画永远走不完。
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => { vi.useRealTimers() })

describe('顶栏版本文字', () => {
  test('已是最新:一行可点的按钮,没有链接、检查更新、恢复内置、已检查', () => {
    renderStatus(releaseOf({ latest: '1.8.6', updateAvailable: false }))

    const trigger = screen.getByRole('button', { name: 'OpenCLI 1.8.6 · 已是最新' })
    expect(trigger).toBe(screen.getByTestId('opencli-release'))
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('update-opencli')).not.toBeInTheDocument()
    expect(screen.queryByTestId('check-updates')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rollback-opencli')).not.toBeInTheDocument()
    expect(screen.queryByTestId('opencli-release-checked-at')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  test.each([
    [new Date(2026, 9, 28, 11, 24), 'OpenCLI 2.0.2 · 已是最新 · 10-28 11:24 更新'],
    [new Date(2026, 0, 5, 3, 7), 'OpenCLI 2.0.2 · 已是最新 · 01-05 03:07 更新'],
  ])('生效的是应用内装的版本:后面带本地时间的「MM-DD HH:mm 更新」(%s)', (installedAt, text) => {
    renderStatus(releaseOf({
      current: '2.0.2', latest: '2.0.2', updateAvailable: false, active: '2.0.2', bundled: '1.8.8', activeInstalledAt: installedAt.getTime(),
    }))

    expect(screen.getByTestId('opencli-release').textContent).toBe(text)
  })

  test('用内置版本(没有更新时间):不带时间', () => {
    renderStatus(releaseOf({ latest: '1.8.6', updateAvailable: false, activeInstalledAt: null }))

    expect(screen.getByTestId('opencli-release').textContent).toBe('OpenCLI 1.8.6 · 已是最新')
  })

  test('有新版:「OpenCLI x 可用」是触发按钮而不是链接,旁边是「更新到 x」', () => {
    renderStatus(releaseOf({ activeInstalledAt: 1_761_600_000_000 }))

    const trigger = screen.getByRole('button', { name: 'OpenCLI 1.8.8 可用' })
    expect(trigger).toBe(screen.getByTestId('opencli-release'))
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(screen.getByRole('button', { name: '更新到 1.8.8' })).toBeEnabled()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByTestId('check-updates')).not.toBeInTheDocument()
  })

  test('检查失败:触发按钮写「OpenCLI x · 检查失败」,原因在 title,没有更新按钮', () => {
    renderRelease({ state: 'error', data: releaseOf(), error: '连不上 npm registry：connect ETIMEDOUT' })

    const trigger = screen.getByRole('button', { name: 'OpenCLI 1.8.6 · 检查失败' })
    expect(trigger).toBe(screen.getByTestId('opencli-release'))
    expect(trigger).toHaveAttribute('title', '连不上 npm registry：connect ETIMEDOUT')
    expect(screen.queryByTestId('update-opencli')).not.toBeInTheDocument()
  })

  test('第一次检查就失败(还没有版本信息):只写「检查失败」', () => {
    renderRelease({ state: 'error', error: '连不上 npm registry' })

    expect(screen.getByTestId('opencli-release').textContent).toBe('检查失败')
  })
})

describe('版本面板', () => {
  test('点触发按钮打开、再点收起;打开时 aria-expanded 为真', async () => {
    renderStatus(releaseOf({ latest: '1.8.6', updateAvailable: false }))
    const trigger = screen.getByTestId('opencli-release')

    const dialog = openPanel()
    expect(dialog).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await panelGone()
  })

  test('已是最新:只有「刚刚检查」+「检查更新」一行,没有内置版本、发布说明、命令目录', () => {
    renderStatus(releaseOf({ latest: '1.8.6', updateAvailable: false }))
    const dialog = openPanel()

    expect(within(dialog).getByTestId('opencli-release-checked-at')).toHaveTextContent('刚刚检查')
    expect(within(dialog).getByRole('button', { name: '检查更新' })).toBeEnabled()
    expect(within(dialog).queryByTestId('rollback-opencli')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument()
    expect(within(dialog).queryByTestId('opencli-panel-catalog')).not.toBeInTheDocument()
  })

  test('检查过一阵子:写成「HH:mm 已检查」', () => {
    const checkedAt = new Date(2026, 9, 28, 9, 5).getTime()
    renderStatus(releaseOf({ checkedAt, latest: '1.8.6', updateAvailable: false }))

    expect(within(openPanel()).getByTestId('opencli-release-checked-at')).toHaveTextContent('09:05 已检查')
  })

  test('有新版:面板里有「查看 x 发布说明」链接指向发布页', () => {
    renderStatus()
    const link = within(openPanel()).getByRole('link', { name: '查看 1.8.8 发布说明' })

    expect(link).toHaveAttribute('href', 'https://github.com/jackwener/opencli/releases/tag/v1.8.8')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  test('给了命令数:面板里显示「命令目录 N 条」', () => {
    renderRelease({ state: 'idle', data: releaseOf({ updateAvailable: false }) }, { commandCount: 117 })

    expect(within(openPanel()).getByTestId('opencli-panel-catalog')).toHaveTextContent('命令目录 117 条')
  })

  test('检查失败:检查那一行写原因,仍可重试;没有发布说明', () => {
    renderRelease({ state: 'error', data: releaseOf(), error: '连不上 npm registry：connect ETIMEDOUT' })
    const dialog = openPanel()

    expect(within(dialog).getByTestId('opencli-release-checked-at')).toHaveTextContent('连不上 npm registry：connect ETIMEDOUT')
    expect(within(dialog).getByRole('button', { name: '检查更新' })).toBeEnabled()
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument()
  })

  test('点「检查更新」:面板关闭,走原来的检查,并清掉顶栏上的错误提示', async () => {
    stubHost({ 'POST /opencli/update': [reply(409, { error: '有命令正在运行，等它结束再更新' })] })
    const { onCheck } = renderStatus()
    fireEvent.click(screen.getByTestId('update-opencli'))
    await elapse(0)
    expect(screen.getByRole('alert')).toHaveTextContent('有命令正在运行，等它结束再更新')

    fireEvent.click(within(openPanel()).getByRole('button', { name: '检查更新' }))

    expect(onCheck).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await panelGone()
  })

  test('active 与 bundled 不同:面板里多一行「内置版本 x」+「恢复内置」,点了调 rollback、面板关闭,成功后重新检查', async () => {
    const host = stubHost({ 'POST /opencli/rollback': [reply(200, { active: null })] })
    const { onCheck } = renderStatus(releaseOf({ current: '1.8.8', latest: '1.8.8', updateAvailable: false, active: '1.8.8', bundled: '1.8.6' }))

    expect(screen.getByTestId('opencli-release')).toHaveTextContent('OpenCLI 1.8.8 · 已是最新')
    const dialog = openPanel()
    expect(dialog).toHaveTextContent('内置版本 1.8.6')
    const button = within(dialog).getByRole('button', { name: '恢复内置版本' })
    expect(button).toHaveTextContent('恢复内置')
    fireEvent.click(button)
    await elapse(0)

    expect(host.count('POST /opencli/rollback')).toBe(1)
    expect(onCheck).toHaveBeenCalledTimes(1)
    await panelGone()
  })

  test('恢复内置失败:顶栏旁显示 Host 给的原因,不重新检查,重新打开面板仍可再试', async () => {
    stubHost({ 'POST /opencli/rollback': [reply(409, { error: '有命令正在运行，等它结束再恢复' })] })
    const { onCheck } = renderStatus(releaseOf({ updateAvailable: false, latest: '1.8.8', current: '1.8.8', active: '1.8.8', bundled: '1.8.6' }))

    fireEvent.click(within(openPanel()).getByTestId('rollback-opencli'))
    await elapse(0)

    expect(screen.getByRole('alert')).toHaveTextContent('有命令正在运行，等它结束再恢复')
    expect(onCheck).not.toHaveBeenCalled()
    await panelGone()
    expect(within(openPanel()).getByTestId('rollback-opencli')).toBeEnabled()
  })

  test('面板开着时开始更新:触发按钮换成进度行,面板跟着收起,更新失败回到触发按钮时面板仍是关的', async () => {
    stubHost({
      'POST /opencli/update': [reply(202, { job: jobOf() })],
      'GET /opencli/update': [idle, running({ state: 'failed', error: { summary: '依赖安装失败' } })],
    })
    renderStatus()
    openPanel()
    fireEvent.click(screen.getByTestId('update-opencli'))
    await elapse(0)

    expect(screen.queryByTestId('opencli-release')).not.toBeInTheDocument()
    await panelGone()

    await poll()
    const trigger = screen.getByTestId('opencli-release')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('opencli-release-panel')).not.toBeInTheDocument()
  })
})

describe('恢复内置进行中', () => {
  const rolledBack = () => releaseOf({ current: '1.8.8', latest: '1.8.8', updateAvailable: false, active: '1.8.8', bundled: '1.8.6' })
  const okRollback = { ok: true, status: 200, json: async () => ({ active: null }) } as Response
  // 宿主重启守护进程要好几秒:这里让 rollback 请求一直挂着,由用例决定何时结束。
  const pendingRollback = () => {
    let finish!: (response: Response) => void
    const responder: Responder = () => new Promise<Response>((resolve) => { finish = resolve })
    return { responder, finish: (response: Response) => act(async () => { finish(response) }) }
  }
  const startRollback = async () => {
    fireEvent.click(within(openPanel()).getByTestId('rollback-opencli'))
    await elapse(0)
  }

  test('在途时顶栏换成不定进度行,触发按钮和面板收起;成功后重新检查并回到触发按钮', async () => {
    const rollback = pendingRollback()
    const host = stubHost({ 'POST /opencli/rollback': [rollback.responder] })
    const { onCheck } = renderStatus(rolledBack())
    await startRollback()

    expect(host.count('POST /opencli/rollback')).toBe(1)
    expect(screen.getByTestId('opencli-rollback-progress')).toHaveTextContent('正在恢复内置 OpenCLI 1.8.6…')
    const bar = screen.getByRole('progressbar', { name: '正在恢复内置 OpenCLI' })
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(screen.queryByTestId('opencli-release')).not.toBeInTheDocument()
    await panelGone()
    expect(onCheck).not.toHaveBeenCalled()

    await rollback.finish(okRollback)
    expect(onCheck).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('opencli-rollback-progress')).not.toBeInTheDocument()
    expect(screen.getByTestId('opencli-release')).toBeInTheDocument()
  })

  test('失败时恢复原样并出红字错误', async () => {
    const rollback = pendingRollback()
    stubHost({ 'POST /opencli/rollback': [rollback.responder] })
    const { onCheck } = renderStatus(rolledBack())
    await startRollback()
    expect(screen.getByTestId('opencli-rollback-progress')).toBeInTheDocument()

    await rollback.finish({ ok: false, status: 409, json: async () => ({ error: '有命令正在运行，等它结束再恢复' }) } as Response)

    expect(screen.queryByTestId('opencli-rollback-progress')).not.toBeInTheDocument()
    expect(screen.getByTestId('opencli-release')).toHaveTextContent('OpenCLI 1.8.8 · 已是最新')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('有命令正在运行，等它结束再恢复')
    expect(alert).toHaveClass('opencli-release-error')
    expect(onCheck).not.toHaveBeenCalled()
  })

  test('在途时更新按钮也被进度行替换,不会同时再发起别的操作', async () => {
    const rollback = pendingRollback()
    stubHost({ 'POST /opencli/rollback': [rollback.responder] })
    renderStatus(releaseOf({ active: '1.8.7', bundled: '1.8.6' }))
    await startRollback()

    expect(screen.queryByTestId('update-opencli')).not.toBeInTheDocument()
    await rollback.finish(okRollback)
  })
})

describe('更新进度', () => {
  test('点「更新到 x」:POST 版本号,顶栏换成确定进度,下方弹出进度卡片', async () => {
    const host = stubHost({ 'POST /opencli/update': [reply(202, { job: jobOf() })] })
    await startUpdate()

    expect(host.count('POST /opencli/update')).toBe(1)
    expect(host.lastBody('POST /opencli/update')).toEqual({ version: '1.8.8' })
    expect(screen.getByTestId('opencli-update-progress')).toHaveTextContent('更新 OpenCLI 1.8.8 · 0%')
    expect(screen.queryByTestId('update-opencli')).not.toBeInTheDocument()
    expect(screen.queryByTestId('opencli-release')).not.toBeInTheDocument()
    expect(card()).not.toHaveAttribute('role')
    expect(card()).not.toHaveAttribute('aria-live')
    expect(announce()).toHaveAttribute('role', 'status')
    expect(announce()).toHaveClass('sr-only')
    expect(announce()).toHaveTextContent(/^查找版本$/)
    expect(card()).toHaveTextContent('OpenCLI 1.8.8')
    expect(meta()).toHaveTextContent(/^查找版本$/)
  })

  test('轮询推进各阶段:阶段文字、百分比、进度条 scaleX 和 MB 格式都跟着变', async () => {
    const host = stubHost({
      'POST /opencli/update': [reply(202, { job: jobOf() })],
      'GET /opencli/update': [
        idle,
        running({ stage: 'download', percent: 24, receivedBytes: 5_000_000, totalBytes: 13_000_000 }),
        running({ stage: 'download', percent: 60, receivedBytes: 13_000_000, totalBytes: 13_000_000 }),
        running({ stage: 'install', percent: 70, totalBytes: 13_000_000 }),
        running({ stage: 'native', percent: 80, totalBytes: 13_000_000 }),
        running({ stage: 'prune', percent: 88, totalBytes: 13_000_000 }),
        running({ stage: 'verify', percent: 95, totalBytes: 13_000_000 }),
        running({ stage: 'switch', percent: 100, totalBytes: 13_000_000 }),
      ],
    })
    await startUpdate()
    expect(polls(host)).toBe(0)

    await poll()
    expect(polls(host)).toBe(1)
    expect(meta()).toHaveTextContent('12.4 MB · 下载中 24%')
    expect(announce()).toHaveTextContent(/^下载中$/)
    expect(fillOf().style.transform).toBe('scaleX(0.24)')
    expect(fillOf()).toHaveAttribute('data-shimmer', 'false')
    expect(screen.getByRole('progressbar', { name: 'OpenCLI 1.8.8 更新进度' })).toHaveAttribute('aria-valuenow', '24')
    expect(screen.getByTestId('opencli-update-progress')).toHaveTextContent('更新 OpenCLI 1.8.8 · 24%')
    expect(screen.getByTestId('opencli-update-bar')).toHaveAttribute('aria-valuenow', '24')
    expect((screen.getByTestId('opencli-update-bar').firstChild as HTMLElement).style.width).toBe('24%')
    expect(screen.getByTestId('opencli-update-card-progress')).toHaveAttribute('data-open', 'true')

    await poll()
    expect(meta()).toHaveTextContent('12.4 MB · 下载中 60%')
    expect(announce()).toHaveTextContent(/^下载中$/)
    expect(fillOf().style.transform).toBe('scaleX(0.6)')

    const rest: Array<[number, string, boolean]> = [
      [70, '安装依赖', true],
      [80, '装回原生命令', false],
      [88, '精简站点', false],
      [95, '校验', true],
      [100, '切换', false],
    ]
    for (const [percent, text, shimmer] of rest) {
      await poll()
      expect(meta()).toHaveTextContent(`12.4 MB · ${text}`)
      expect(announce()).toHaveTextContent(text)
      expect(announce().textContent).not.toMatch(/\d/)
      expect(fillOf().style.transform).toBe(`scaleX(${percent / 100})`)
      expect(fillOf()).toHaveAttribute('data-shimmer', String(shimmer))
    }
  })

  test('单次轮询失败不打断更新,下一轮继续', async () => {
    const host = stubHost({
      'POST /opencli/update': [reply(202, { job: jobOf() })],
      'GET /opencli/update': [
        idle,
        () => Promise.reject(new TypeError('Failed to fetch')),
        running({ stage: 'download', percent: 33 }),
      ],
    })
    await startUpdate()
    await poll()
    expect(card()).toHaveAttribute('data-state', 'running')
    await poll()

    expect(polls(host)).toBe(2)
    expect(meta()).toHaveTextContent('下载中 33%')
  })

  test('Host 已不认得这个任务(返回 null):收起卡片,顶栏恢复', async () => {
    stubHost({
      'POST /opencli/update': [reply(202, { job: jobOf() })],
      'GET /opencli/update': [idle, reply(200, { job: null })],
    })
    await startUpdate()
    await poll()

    await cardGone()
    expect(screen.queryByTestId('opencli-update-progress')).not.toBeInTheDocument()
    expect(screen.getByTestId('update-opencli')).toBeInTheDocument()
  })

  test('409:不出现卡片,顶栏旁显示原因,按钮仍可再点,再检查时清掉', async () => {
    const host = stubHost({ 'POST /opencli/update': [reply(409, { error: '有命令正在运行，等它结束再更新' })] })
    const { onCheck } = await startUpdate()

    expect(screen.getByRole('alert')).toHaveTextContent('有命令正在运行，等它结束再更新')
    expect(screen.queryByTestId('opencli-update-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('opencli-update-progress')).not.toBeInTheDocument()
    expect(screen.getByTestId('update-opencli')).toBeEnabled()
    expect(polls(host)).toBe(0)

    fireEvent.click(within(openPanel()).getByTestId('check-updates'))
    expect(onCheck).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('卸载后停止轮询', async () => {
    const host = stubHost({
      'POST /opencli/update': [reply(202, { job: jobOf() })],
      'GET /opencli/update': [idle, running({ stage: 'download', percent: 10 })],
    })
    const { unmount } = await startUpdate()
    await poll()
    await poll()
    expect(polls(host)).toBe(2)

    unmount()
    await elapse(3000)
    expect(polls(host)).toBe(2)
  })
})

describe('接上进行中的任务', () => {
  test('挂载时 Host 里的任务仍在 running:弹出卡片、顶栏换成进度,并继续轮询', async () => {
    const host = stubHost({
      'GET /opencli/update': [
        running({ stage: 'download', percent: 40, totalBytes: 13_000_000 }),
        running({ stage: 'download', percent: 55, totalBytes: 13_000_000 }),
      ],
    })
    renderStatus()
    await elapse(0)

    expect(meta()).toHaveTextContent('12.4 MB · 下载中 40%')
    expect(screen.getByTestId('opencli-update-progress')).toHaveTextContent('更新 OpenCLI 1.8.8 · 40%')
    expect(host.count('POST /opencli/update')).toBe(0)
    await poll()
    expect(host.count('GET /opencli/update')).toBe(2)
    expect(meta()).toHaveTextContent('12.4 MB · 下载中 55%')
  })

  test.each([
    ['没有任务', reply(200, { job: null })],
    ['任务已成功', reply(200, { job: jobOf({ state: 'succeeded', stage: 'done', percent: 100 }) })],
    ['任务已失败', reply(200, { job: jobOf({ state: 'failed', error: { summary: '依赖安装失败' } }) })],
    ['查询失败', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('挂载时%s:什么都不做,也不轮询', async (_name, responder) => {
    const host = stubHost({ 'GET /opencli/update': [responder] })
    renderStatus()
    await elapse(0)
    await elapse(2000)

    expect(host.count('GET /opencli/update')).toBe(1)
    expect(screen.queryByTestId('opencli-update-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('opencli-update-progress')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('update-opencli')).toBeEnabled()
  })

  test('未连着 Host(enabled=false):不发任何请求', async () => {
    const host = stubHost({ 'GET /opencli/update': [running({ percent: 40 })] })
    renderStatus(releaseOf(), false)
    await elapse(2000)

    expect(host.count('GET /opencli/update')).toBe(0)
    expect(screen.queryByTestId('opencli-update-card')).not.toBeInTheDocument()
  })
})

describe('取消', () => {
  test('调 cancel,卡片收起,顶栏恢复成「更新到 x」', async () => {
    const host = stubHost({
      'POST /opencli/update': [reply(202, { job: jobOf() })],
      'POST /opencli/update/cancel': [reply(200, { job: jobOf({ state: 'cancelled' }) })],
    })
    const { onCheck } = await startUpdate()

    fireEvent.click(screen.getByRole('button', { name: '取消更新' }))
    await elapse(0)
    expect(host.count('POST /opencli/update/cancel')).toBe(1)
    await cardGone()
    expect(screen.queryByTestId('opencli-update-progress')).not.toBeInTheDocument()
    expect(screen.getByTestId('update-opencli')).toBeEnabled()
    expect(onCheck).not.toHaveBeenCalled()
  })

  test('取消请求返回时任务仍在收尾:继续轮询,直到变成 cancelled 才收起', async () => {
    stubHost({
      'POST /opencli/update': [reply(202, { job: jobOf() })],
      'POST /opencli/update/cancel': [reply(200, { job: jobOf() })],
      'GET /opencli/update': [idle, reply(200, { job: jobOf({ state: 'cancelled' }) })],
    })
    await startUpdate()

    fireEvent.click(screen.getByRole('button', { name: '取消更新' }))
    await elapse(0)
    expect(card()).toBeInTheDocument()
    await poll()
    await cardGone()
    expect(screen.getByTestId('update-opencli')).toBeInTheDocument()
  })
})

describe('失败', () => {
  const failedJob = jobOf({
    state: 'failed', stage: 'install', percent: 70, totalBytes: 13_000_000,
    error: { summary: '依赖安装失败', detail: 'npm ERR! network timeout' }, finishedAt: 2,
  })
  const failingHost = () => stubHost({
    'POST /opencli/update': [reply(202, { job: jobOf() }), reply(202, { job: jobOf({ id: 'job-2' }) })],
    'GET /opencli/update': [idle, reply(200, { job: failedJob }), reply(200, { job: jobOf({ id: 'job-2', stage: 'download', percent: 10 }) })],
  })

  test('卡片标成失败并显示 error.summary,顶栏恢复成更新前的样子,进度条收起', async () => {
    failingHost()
    await startUpdate()
    await poll()

    expect(card()).toHaveAttribute('data-state', 'failed')
    expect(screen.getByTestId('opencli-update-card-status')).toHaveTextContent('依赖安装失败')
    expect(screen.getByTestId('opencli-update-card-status')).toHaveAttribute('title', 'npm ERR! network timeout')
    expect(meta()).toHaveTextContent('12.4 MB · 依赖安装失败')
    expect(announce()).toHaveTextContent(/^依赖安装失败$/)
    expect(screen.getByTestId('opencli-update-card-progress')).toHaveAttribute('data-open', 'false')
    expect(screen.queryByTestId('opencli-update-progress')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'OpenCLI 1.8.8 可用' })).toBeInTheDocument()
    expect(screen.getByTestId('update-opencli')).toBeEnabled()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消更新' })).not.toBeInTheDocument()
  })

  test('卡片留着不自动消失;点 ↻ 重新 POST 同一个版本,卡片回到进行中', async () => {
    const host = failingHost()
    await startUpdate()
    await poll()
    await elapse(10_000)
    expect(card()).toHaveAttribute('data-state', 'failed')

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await elapse(0)
    expect(host.count('POST /opencli/update')).toBe(2)
    expect(host.lastBody('POST /opencli/update')).toEqual({ version: '1.8.8' })
    expect(card()).toHaveAttribute('data-state', 'running')
    expect(screen.getByTestId('opencli-update-progress')).toHaveTextContent('更新 OpenCLI 1.8.8 · 0%')

    await poll()
    expect(meta()).toHaveTextContent('下载中 10%')
    expect(screen.getByTestId('opencli-update-card-progress')).toHaveAttribute('data-open', 'true')
  })

  test('点 × 关闭卡片', async () => {
    failingHost()
    await startUpdate()
    await poll()

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await cardGone()
    expect(screen.getByTestId('update-opencli')).toBeInTheDocument()
  })
})

describe('成功', () => {
  const succeeded = (over: Partial<OpencliUpdateJob> = {}) => jobOf({
    state: 'succeeded', stage: 'done', percent: 100, totalBytes: 13_000_000, finishedAt: 2, ...over,
  })
  const succeedingHost = (job: OpencliUpdateJob) => stubHost({
    'POST /opencli/update': [reply(202, { job: jobOf() })],
    'GET /opencli/update': [idle, reply(200, { job })],
  })

  test('出现角标和「已更新到 x」,3 秒后卡片收起、顶栏恢复并重新检查', async () => {
    const host = succeedingHost(succeeded())
    const { onCheck } = await startUpdate()
    expect(screen.queryByTestId('opencli-update-card-badge')).not.toBeInTheDocument()

    await poll()
    expect(screen.getByTestId('opencli-update-card-badge')).toBeInTheDocument()
    expect(meta()).toHaveTextContent('12.4 MB · 已更新到 1.8.8')
    expect(announce()).toHaveTextContent(/^已更新到 1.8.8$/)
    expect(screen.getByTestId('opencli-update-card-progress')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('opencli-update-progress')).toHaveTextContent('更新 OpenCLI 1.8.8 · 100%')
    expect(screen.queryByRole('button', { name: '取消更新' })).not.toBeInTheDocument()

    await elapse(2900)
    expect(onCheck).not.toHaveBeenCalled()
    expect(card()).toBeInTheDocument()
    await elapse(100)
    expect(onCheck).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('opencli-update-progress')).not.toBeInTheDocument()
    await cardGone()

    await elapse(5000)
    expect(onCheck).toHaveBeenCalledTimes(1)
    expect(polls(host)).toBe(1)
    expect(screen.queryByTestId('opencli-extension-warning')).not.toBeInTheDocument()
  })

  const STORE_NOTE = '商店版会由 Chrome 自动更新；装的是 GitHub 解压版的，改装商店版后就不用再手动下载'
  const outdated = { code: 'extension-outdated', message: '浏览器扩展版本偏旧' }

  test('带 extension-outdated 警告:卡片收起后顶栏下方留一条提示,关闭后消失', async () => {
    succeedingHost(succeeded({ warnings: [{ code: 'other', message: '无关警告' }, outdated] }))
    await startUpdate()
    await poll()
    expect(screen.queryByTestId('opencli-extension-warning')).not.toBeInTheDocument()

    await elapse(3000)
    await cardGone()
    const warning = screen.getByTestId('opencli-extension-warning')
    expect(warning).toHaveTextContent('浏览器扩展版本偏旧')
    expect(warning).toHaveTextContent(STORE_NOTE)
    expect(warning).not.toHaveTextContent('无关警告')
    expect(within(warning).queryByRole('link')).not.toBeInTheDocument()
    expect(within(warning).getByRole('button', { name: '在 Chrome 打开商店页' })).toBeEnabled()

    await elapse(5000)
    expect(screen.getByTestId('opencli-extension-warning')).toBeInTheDocument()
    fireEvent.click(within(warning).getByRole('button', { name: '关闭提示' }))
    expect(screen.queryByTestId('opencli-extension-warning')).not.toBeInTheDocument()
  })

  test('恢复内置成功后,针对被换掉那个版本的扩展提醒一并清掉;失败则保留', async () => {
    stubHost({
      'POST /opencli/update': [reply(202, { job: jobOf() })],
      'GET /opencli/update': [idle, reply(200, { job: succeeded({
        warnings: [outdated],
      }) })],
      'POST /opencli/rollback': [reply(409, { error: '有命令正在运行，等它结束再恢复' }), reply(200, { active: null })],
    })
    const { onCheck } = await startUpdate(releaseOf({ active: '1.8.7' }))
    await poll()
    await elapse(3000)
    await cardGone()
    expect(screen.getByTestId('opencli-extension-warning')).toBeInTheDocument()
    expect(onCheck).toHaveBeenCalledTimes(1)

    fireEvent.click(within(openPanel()).getByTestId('rollback-opencli'))
    await elapse(0)
    expect(screen.getByRole('alert')).toHaveTextContent('有命令正在运行')
    expect(screen.getByTestId('opencli-extension-warning')).toBeInTheDocument()
    await panelGone()

    fireEvent.click(within(openPanel()).getByTestId('rollback-opencli'))
    await elapse(0)
    expect(screen.queryByTestId('opencli-extension-warning')).not.toBeInTheDocument()
    expect(onCheck).toHaveBeenCalledTimes(2)
  })

  describe('在 Chrome 打开商店页', () => {
    const openStore = async (responder: Responder) => {
      const host = stubHost({
        'POST /opencli/update': [reply(202, { job: jobOf() })],
        'GET /opencli/update': [idle, reply(200, { job: succeeded({ warnings: [outdated] }) })],
        'POST /browser-bridge/open-extension-page': [responder],
      })
      await startUpdate()
      await poll()
      await elapse(3000)
      await cardGone()
      fireEvent.click(screen.getByTestId('open-extension-store'))
      await elapse(0)
      return host
    }

    test('点按钮请求宿主打开商店页;成功后不额外提示,提醒仍在', async () => {
      const host = await openStore(reply(200, { ok: true }))

      expect(host.count('POST /browser-bridge/open-extension-page')).toBe(1)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.getByTestId('opencli-extension-warning')).toBeInTheDocument()
      expect(screen.getByTestId('open-extension-store')).toBeEnabled()
    })

    test('没找到 Chrome:顶栏显示中文原因', async () => {
      await openStore(reply(200, { ok: false, reasonCode: 'chrome-not-found' }))

      expect(screen.getByRole('alert')).toHaveTextContent('没找到 Chrome，请先安装 Chrome')
      expect(screen.getByTestId('opencli-extension-warning')).toBeInTheDocument()
    })

    test('其他打不开的原因:提示手动去应用店搜索', async () => {
      await openStore(reply(200, { ok: false, reasonCode: 'launch-failed' }))

      expect(screen.getByRole('alert')).toHaveTextContent('没能打开 Chrome，请手动打开 Chrome 应用店搜索 OpenCLI')
    })

    test('请求没送到:同样走顶栏错误提示', async () => {
      await openStore(reply(500, {}))

      expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500')
    })
  })

  test('成功等待期间卸载:不再触发重新检查', async () => {
    succeedingHost(succeeded())
    const { onCheck, unmount } = await startUpdate()
    await poll()

    unmount()
    await elapse(5000)
    expect(onCheck).not.toHaveBeenCalled()
  })
})
