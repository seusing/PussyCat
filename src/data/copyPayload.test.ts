import { copyPayloadFor, type CopyableRun } from './copyPayload'

const base: CopyableRun = { state: 'succeeded', lines: [], result: undefined, error: undefined }

test('succeeded → 复制结构化结果(result JSON,缩进2;缺省=[])', () => {
  expect(copyPayloadFor({ ...base, result: [{ a: 1 }] }))
    .toEqual({ label: '复制结构化结果', text: JSON.stringify([{ a: 1 }], null, 2) })
  expect(copyPayloadFor(base)!.text).toBe('[]')
})

test('failed → 复制日志(lines 按 seq 升序 join)', () => {
  const run: CopyableRun = { ...base, state: 'failed', lines: [
    { seq: 2, text: 'world' }, { seq: 1, text: 'hello' },
  ] }
  expect(copyPayloadFor(run)).toEqual({ label: '复制日志', text: 'hello\nworld' })
})

test('failed 且 lines=[] → 回退 error.summary+detail(启动失败可复制)', () => {
  const run: CopyableRun = { ...base, state: 'failed', error: { summary: 'boom', detail: 'stack' } }
  expect(copyPayloadFor(run)!.text).toBe('boom\nstack')
  expect(copyPayloadFor({ ...base, state: 'failed', error: { summary: 'boom' } })!.text).toBe('boom')
})

test('cancelled → 复制日志', () => {
  expect(copyPayloadFor({ ...base, state: 'cancelled', lines: [{ seq: 1, text: 'x' }] })!.label).toBe('复制日志')
})

test('非终态 → null', () => {
  for (const state of ['idle', 'starting', 'running', 'cancelling']) {
    expect(copyPayloadFor({ ...base, state })).toBeNull()
  }
})
