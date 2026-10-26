import { alignBand, firstBarFrom, lastBarUntil } from './chartTime'

const DAILY = ['2026-04-23', '2026-04-24', '2026-04-27'].map((time) => ({ time }))

// 分钟级 time 是北京钟面当作 UTC 编码的整数秒。
const clock = (day: string, hour = 0, minute = 0, second = 0) => {
  const [year, month, date] = day.split('-').map(Number)
  return Date.UTC(year, month - 1, date, hour, minute, second) / 1000
}
const INTRADAY = [
  clock('2026-10-26', 10, 30),
  clock('2026-10-26', 15, 0),
  clock('2026-10-26', 23, 59, 59),
  clock('2026-10-27', 0, 0),
  clock('2026-10-27', 10, 30),
].map((time) => ({ time }))

describe('firstBarFrom', () => {
  it('字符串 time:取该日当天或之后的第一根,该日没有 K 线就顺延到下一根', () => {
    expect(firstBarFrom(DAILY, '2026-04-24')).toBe('2026-04-24')
    expect(firstBarFrom(DAILY, '2026-04-25')).toBe('2026-04-27')
    expect(firstBarFrom(DAILY, '2026-04-01')).toBe('2026-04-23')
  })

  it('字符串 time:该日晚于最后一根返回 null', () => {
    expect(firstBarFrom(DAILY, '2026-04-28')).toBeNull()
  })

  it('数字 time:该日 00:00(UTC 秒数)起的第一根,恰在 00:00 的那根属于这一天', () => {
    expect(firstBarFrom(INTRADAY, '2026-10-26')).toBe(clock('2026-10-26', 10, 30))
    expect(firstBarFrom(INTRADAY, '2026-10-27')).toBe(clock('2026-10-27', 0, 0))
    expect(firstBarFrom(INTRADAY, '2026-10-25')).toBe(clock('2026-10-26', 10, 30))
  })

  it('数字 time:该日晚于最后一根返回 null', () => {
    expect(firstBarFrom(INTRADAY, '2026-10-28')).toBeNull()
  })
})

describe('lastBarUntil', () => {
  it('字符串 time:取该日当天或之前的最后一根', () => {
    expect(lastBarUntil(DAILY, '2026-04-27')).toBe('2026-04-27')
    expect(lastBarUntil(DAILY, '2026-04-26')).toBe('2026-04-24')
    expect(lastBarUntil(DAILY, '2026-05-30')).toBe('2026-04-27')
  })

  it('字符串 time:该日早于第一根返回 null', () => {
    expect(lastBarUntil(DAILY, '2026-04-22')).toBeNull()
  })

  it('数字 time:截至该日 23:59:59 的最后一根,次日 00:00 的那根不算', () => {
    expect(lastBarUntil(INTRADAY, '2026-10-26')).toBe(clock('2026-10-26', 23, 59, 59))
    expect(lastBarUntil(INTRADAY, '2026-10-27')).toBe(clock('2026-10-27', 10, 30))
    expect(lastBarUntil(INTRADAY, '2026-11-30')).toBe(clock('2026-10-27', 10, 30))
  })

  it('数字 time:该日早于第一根返回 null', () => {
    expect(lastBarUntil(INTRADAY, '2026-10-25')).toBeNull()
  })
})

describe('alignBand', () => {
  it('起点取 from 当天或之后的第一根,终点取 to 当天或之前的最后一根', () => {
    expect(alignBand(DAILY, '2026-04-24', '2026-04-27')).toEqual({ from: '2026-04-24', to: '2026-04-27' })
    expect(alignBand(DAILY, '2026-04-25', '2026-04-30')).toEqual({ from: '2026-04-27', to: '2026-04-27' })
    expect(alignBand(INTRADAY, '2026-10-26', '2026-10-26')).toEqual({
      from: clock('2026-10-26', 10, 30),
      to: clock('2026-10-26', 23, 59, 59),
    })
  })

  it('只有一端越界时贴到数据边缘', () => {
    expect(alignBand(DAILY, '2026-03-01', '2026-04-24')).toEqual({ from: '2026-04-23', to: '2026-04-24' })
    expect(alignBand(DAILY, '2026-04-24', '2026-12-31')).toEqual({ from: '2026-04-24', to: '2026-04-27' })
  })

  it('完全在数据范围外、或两端之间没有 K 线时返回 null', () => {
    expect(alignBand(DAILY, '2026-01-01', '2026-04-22')).toBeNull()
    expect(alignBand(DAILY, '2026-04-28', '2026-06-01')).toBeNull()
    expect(alignBand(DAILY, '2026-04-25', '2026-04-26')).toBeNull()
    expect(alignBand(INTRADAY, '2026-10-01', '2026-10-25')).toBeNull()
  })
})
