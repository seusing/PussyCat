/** K 线的 time:日、周、月是 YYYY-MM-DD,分钟级是整数秒(北京钟面当作 UTC 编码)。一张图里不会混用。 */
export type BarTime = string | number

/** 一天的 [起点, 终点] 在这组 K 线 time 里的表示:字符串 time 直接用日期比较,数字 time 用该日的 UTC 秒数。 */
function dayBounds(bars: ReadonlyArray<{ time: BarTime }>, day: string): [BarTime, BarTime] {
  if (typeof bars[0]?.time !== 'number') return [day, day]
  const [year, month, date] = day.split('-').map(Number)
  const start = Date.UTC(year, month - 1, date) / 1000
  return [start, start + 86_399]
}

/** 该日 00:00 起的第一根 K 线;该日晚于最后一根返回 null。 */
export function firstBarFrom(bars: ReadonlyArray<{ time: BarTime }>, day: string): BarTime | null {
  const [start] = dayBounds(bars, day)
  return bars.find((bar) => bar.time >= start)?.time ?? null
}

/** 截至该日 23:59:59 的最后一根 K 线;该日早于第一根返回 null。 */
export function lastBarUntil(bars: ReadonlyArray<{ time: BarTime }>, day: string): BarTime | null {
  const [, end] = dayBounds(bars, day)
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    if (bars[index].time <= end) return bars[index].time
  }
  return null
}

/**
 * 时段落在 K 线上的两端:起点取 from 当天或之后的第一根,终点取 to 当天或之前的最后一根。
 * 只有一端越界时贴到数据边缘;时段完全在数据范围外、或两端之间一根 K 线都没有时返回 null。
 */
export function alignBand(
  bars: ReadonlyArray<{ time: BarTime }>,
  from: string,
  to: string,
): { from: BarTime; to: BarTime } | null {
  const start = firstBarFrom(bars, from)
  const end = lastBarUntil(bars, to)
  if (start === null || end === null || start > end) return null
  return { from: start, to: end }
}
