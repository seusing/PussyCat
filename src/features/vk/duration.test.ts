import { afterEach, describe, expect, it, vi } from 'vitest'
import { vkDurationLabel, vkElapsedLabel } from './taskUiState'

afterEach(() => vi.useRealTimers())

describe('vkDurationLabel', () => {
  it.each([
    [null, '进行中'],
    [0, '0ms'],
    [0.022, '22ms'],
    [0.0226, '23ms'],
    [0.9994, '999ms'],
    [0.9996, '1s'],
    [1, '1s'],
    [2.5, '2.5s'],
    [2.567, '2.57s'],
    [59.999, '1m'],
    [60, '1m'],
    [106.85, '1m46.85s'],
    [3599.999, '1h'],
    [3600, '1h'],
    [3720, '1h2m'],
    [86399.999, '1d'],
    [86400, '1d'],
    [90000, '1d1h'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(vkDurationLabel(seconds)).toBe(expected)
  })
})

describe('vkElapsedLabel', () => {
  it('preserves milliseconds between submission and completion', () => {
    expect(vkElapsedLabel('2026-09-02T10:00:00.000Z', '2026-09-02T10:01:46.850Z')).toBe('1m46.85s')
    expect(vkElapsedLabel('2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.022Z')).toBe('22ms')
  })

  it('uses the current clock for unfinished tasks and clamps negative elapsed time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T10:00:02.500Z'))
    expect(vkElapsedLabel('2026-09-02T10:00:00.000Z')).toBe('2.5s')
    expect(vkElapsedLabel('2026-09-02T10:00:03.000Z')).toBe('0ms')
    expect(vkElapsedLabel('invalid')).toBe('—')
  })
})
