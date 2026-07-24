import { readFileSync } from 'node:fs'
import { assertCatalogCommands, CatalogSchemaError } from './catalogSchema'

const ok = (over: object = {}) => ({ command: 'a/b', site: 'a', name: 'b', description: '', access: 'read', browser: false, args: [], ...over })

test('args:[null] 拒绝(三轮复审 F2 原案例)', () => {
  expect(() => assertCatalogCommands([ok({ args: [null] })])).toThrow(CatalogSchemaError)
})
test('args 元素缺 name/type 拒绝', () => {
  expect(() => assertCatalogCommands([ok({ args: [{ name: 'x' }] })])).toThrow(/参数元素非法/)
})
test('choices 元素非法拒绝;合法两形态放行', () => {
  expect(() => assertCatalogCommands([ok({ args: [{ name: 'x', type: 'str', choices: [42] }] })])).toThrow(/choices 元素非法/)
  expect(() => assertCatalogCommands([ok({ args: [{ name: 'x', type: 'str', choices: ['a', { label: 'L', value: 'v' }] }] })])).not.toThrow()
})
test('key 不一致拒绝', () => {
  expect(() => assertCatalogCommands([ok({ command: 'a/c' })])).toThrow(/key 不一致/)
})
test('重复 command 拒绝', () => {
  expect(() => assertCatalogCommands([ok(), ok()])).toThrow(/key 重复/)
})
test('真实 catalog 快照 1278 命令通过深校验(真实数据门)', () => {
  const snap = JSON.parse(readFileSync('public/catalog.snapshot.json', 'utf8'))
  expect(() => assertCatalogCommands(snap.commands)).not.toThrow()
  expect(snap.commands.length).toBeGreaterThan(1000)
})
