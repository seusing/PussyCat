import { sharedKeyGroups } from './sharedKeyReminder'

const live = (...ids: string[]) => new Set(ids)

describe('sharedKeyGroups', () => {
  test('旧版引擎不返回 key_shared_with 时不抛错,也不分组', () => {
    const channels = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]

    expect(sharedKeyGroups(channels, live('a', 'b'))).toEqual([])
  })

  test('字段只在部分通道上缺失时,其余通道照常分组', () => {
    const channels = [
      { id: 'a', name: 'A', key_shared_with: ['b'] },
      { id: 'b', name: 'B', key_shared_with: ['a'] },
      { id: 'c', name: 'C' },
    ]

    expect(sharedKeyGroups(channels, live('a', 'b', 'c'))).toEqual([{ id: 'a|b', names: ['A', 'B'] }])
  })

  test('只算仍在列表里的通道', () => {
    const channels = [
      { id: 'a', name: 'A', key_shared_with: ['b'] },
      { id: 'b', name: 'B', key_shared_with: ['a'] },
    ]

    expect(sharedKeyGroups(channels, live('a'))).toEqual([])
  })
})
