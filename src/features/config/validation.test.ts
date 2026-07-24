import { validate } from './validation'
import type { CommandManifest } from '../../data/types'

const cmd: CommandManifest = {
  command: 'x/go', site: 'x', name: 'go', description: '', access: 'read', browser: false,
  args: [
    { name: 'url', type: 'str', required: true },
    { name: 'count', type: 'int' },
  ],
}

test('必填缺失报错', () => {
  expect(validate(cmd, {})).toEqual({ url: '此字段必填' })
})
test('数字字段非数值报错', () => {
  expect(validate(cmd, { url: 'x', count: 'abc' })).toEqual({ count: '请输入数字' })
})
test('合法输入无错误', () => {
  expect(validate(cmd, { url: 'x', count: 5 })).toEqual({})
})
test('validate：位置参数中间空、后面有值 → 报错（不可跳过）', () => {
  const c: CommandManifest = {
    command: 'xianyu/messages', site: 'xianyu', name: 'messages', description: '', access: 'read', browser: false,
    args: [
      { name: 'item_id', type: 'str', positional: true },
      { name: 'user_id', type: 'str', positional: true },
    ],
  }
  expect(validate(c, { user_id: 'u1' })).toEqual({ item_id: '位置参数不能跳过：填了后面的就必须先填它' })
  expect(validate(c, { item_id: 'i1', user_id: 'u1' })).toEqual({})
  expect(validate(c, {})).toEqual({})
})
