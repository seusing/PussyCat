import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { applyForecastLines } from './forecastLines'
import { TermHintMarkdown } from './TermHint'

const STALE = '预测核验 · 尚未到期：看涨，期限至 2026-11-03。至今 +4.1%（平常波动的 6.9 倍，偏向应验）；期间最高 +4.3%（2026-10-26），最低 +0.8%（2026-10-21）。'
const FRESH = '预测核验 · 应验：看涨，期限至 2026-11-03。期末 +10.5%（平常波动的 10.9 倍）；期间最高 +10.7%（2026-11-03），最低 +0.8%（2026-10-21）。（行情截至 2026-11-03）'
const NOTE = `- 关键点\n  >\n  > ${STALE}`

describe('applyForecastLines', () => {
  it('按旧行文字替换,没有匹配的行原样保留', () => {
    const other = '预测核验 · 暂不核验：别的'
    expect(applyForecastLines(`a\n> ${STALE}\n> ${other}\nb`, { [STALE]: FRESH })).toBe(`a\n> ${FRESH}\n> ${other}\nb`)
  })

  it('同一行出现多次时全部替换,新行里的 $ 不当作替换模式', () => {
    expect(applyForecastLines(`${STALE}|${STALE}`, { [STALE]: '新 $& 行' })).toBe('新 $& 行|新 $& 行')
  })

  it('没有重算结果时原文不变', () => {
    expect(applyForecastLines(NOTE, null)).toBe(NOTE)
    expect(applyForecastLines(NOTE, {})).toBe(NOTE)
  })
})

describe('笔记里的预测核验行用最新行情重算', () => {
  afterEach(() => { cleanup() })

  const renderNote = (props: { note?: string; figureJobId?: string } = {}) => render(
    <TermHintMarkdown terms={[]} note={null} figureJobId={'figureJobId' in props ? props.figureJobId : 'run:r1'} baseUrl="http://host">
      {props.note ?? NOTE}
    </TermHintMarkdown>,
  )
  const stubForecasts = (reply: () => Promise<Response>) => {
    const fetchMock = vi.fn(reply)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const forecastCard = () => screen.getByRole('note', { name: '预测核验' })

  it('取回后换成新行:徽标和正文跟着变,只取一次', async () => {
    const fetchMock = stubForecasts(async () => Response.json({ lines: { [STALE]: FRESH } }))
    renderNote()

    expect(within(forecastCard()).getByText('尚未到期')).toHaveClass('is-pending')
    await waitFor(() => expect(within(forecastCard()).getByText('应验')).toHaveClass('is-hit'))
    expect(forecastCard()).toHaveTextContent('行情截至 2026-11-03')
    expect(forecastCard()).not.toHaveTextContent('尚未到期')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('http://host/vk/v1/jobs/run:r1/forecasts')
  })

  it.each([
    ['请求出错', () => Promise.reject(new TypeError('network'))],
    ['引擎回错误', async () => Response.json({ error: '任务不存在' }, { status: 404 })],
    ['没有匹配的行', async () => Response.json({ lines: { '预测核验 · 别的行': FRESH } })],
    ['返回体不是约定的形状', async () => Response.json({ lines: { [STALE]: 5 } })],
  ])('%s:继续显示原文,不报错', async (_name, reply) => {
    const fetchMock = stubForecasts(reply)
    renderNote()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(within(forecastCard()).getByText('尚未到期')).toHaveClass('is-pending')
    expect(forecastCard()).not.toHaveTextContent('行情截至')
  })

  it('笔记没有预测核验行,或不知道任务,就不发请求', () => {
    const fetchMock = stubForecasts(async () => Response.json({ lines: {} }))
    renderNote({ note: '- 只有一个关键点' })
    renderNote({ figureJobId: undefined })

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
