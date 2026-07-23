import { transition } from './runMachine'

test('idle→validating→starting→running→succeeded', () => {
  expect(transition('idle', { type: 'RUN' })).toBe('validating')
  expect(transition('validating', { type: 'VALID' })).toBe('starting')
  expect(transition('starting', { type: 'OUTPUT' })).toBe('running')
  expect(transition('running', { type: 'DONE', outcome: 'success' })).toBe('succeeded')
})

test('校验失败回 idle', () => {
  expect(transition('validating', { type: 'INVALID' })).toBe('idle')
})

test('启动异常直接 failed', () => {
  expect(transition('starting', { type: 'DONE', outcome: 'error' })).toBe('failed')
})

test('取消：running→cancelling→cancelled', () => {
  expect(transition('running', { type: 'CANCEL' })).toBe('cancelling')
  expect(transition('cancelling', { type: 'DONE', outcome: 'cancelled' })).toBe('cancelled')
})

test('done 的 outcome 决定终态', () => {
  expect(transition('running', { type: 'DONE', outcome: 'error' })).toBe('failed')
  expect(transition('running', { type: 'DONE', outcome: 'cancelled' })).toBe('cancelled')
})

test('终态幂等，不再迁移', () => {
  expect(transition('succeeded', { type: 'RUN' })).toBe('succeeded')
  expect(transition('failed', { type: 'RUN' })).toBe('failed')
  expect(transition('cancelled', { type: 'RUN' })).toBe('cancelled')
})
