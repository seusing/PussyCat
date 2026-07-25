import { HostRequestError } from './errors'

test('message 恒等于 summary——detail 绝不拼进 message(复审 P3 契约锁)', () => {
  const e = new HostRequestError('策略拒绝', 'Command is outside policy', 403)
  expect(e.message).toBe('策略拒绝')
  expect(e.message).not.toContain('Command is outside policy')   // 通用 Error.message 消费者拿不到 detail
  expect(e.summary).toBe('策略拒绝')
  expect(e.detail).toBe('Command is outside policy')
  expect(e.status).toBe(403)
})

test('无 detail 时字段与 message 一致;仍是 Error 实例(消费方兼容)', () => {
  const e = new HostRequestError('boom')
  expect(e.message).toBe('boom')
  expect(e.detail).toBeUndefined()
  expect(e).toBeInstanceOf(Error)
  expect(e.name).toBe('HostRequestError')
})
