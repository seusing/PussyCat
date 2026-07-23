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
