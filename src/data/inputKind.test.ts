import { inputKind } from './inputKind'
import type { ManifestArg } from './types'

const arg = (p: Partial<ManifestArg>): ManifestArg => ({ name: 'a', type: 'str', ...p })

test('choices -> select（优先级最高）', () => {
  expect(inputKind(arg({ type: 'str', choices: ['a', 'b'] }))).toBe('select')
})
test('bool/boolean -> switch', () => {
  expect(inputKind(arg({ type: 'bool' }))).toBe('switch')
  expect(inputKind(arg({ type: 'boolean' }))).toBe('switch')
})
test('int/number/float -> number', () => {
  expect(inputKind(arg({ type: 'int' }))).toBe('number')
  expect(inputKind(arg({ type: 'number' }))).toBe('number')
  expect(inputKind(arg({ type: 'float' }))).toBe('number')
})
test('str/string -> text（兜底）', () => {
  expect(inputKind(arg({ type: 'str' }))).toBe('text')
  expect(inputKind(arg({ type: 'string' }))).toBe('text')
})
