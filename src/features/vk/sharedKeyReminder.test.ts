import { sharedKeyGroups, sharedKeyGroupTitle, sharedKeyPeers } from './sharedKeyReminder'

const LONG_MASK = 'sk-rela••••••••••6789'
const SHORT_MASK = 'sk-••••••••'

const ch = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id.toUpperCase(), key_env: `VK_${id.toUpperCase()}_KEY`, key_masked: '', ...over,
})
const live = (...ids: string[]) => new Set(ids)

describe('sharedKeyPeers', () => {
  test('新版引擎给了 key_shared_with 就以它为准', () => {
    const channels = [ch('a', { key_shared_with: ['b'] }), ch('b', { key_shared_with: ['a'] }), ch('c', { key_shared_with: [] })]

    expect(sharedKeyPeers(channels[0], channels)).toEqual(['b'])
    expect(sharedKeyPeers(channels[2], channels)).toEqual([])
  })

  test('字段说不共用时,即使 key_env 相同也不识别', () => {
    const channels = [
      ch('a', { key_env: 'VK_SAME_KEY', key_masked: LONG_MASK, key_shared_with: [] }),
      ch('b', { key_env: 'VK_SAME_KEY', key_masked: LONG_MASK, key_shared_with: [] }),
    ]

    expect(sharedKeyPeers(channels[0], channels)).toEqual([])
  })

  test('旧版引擎没有字段:key_env 相同就算共用,按通道顺序', () => {
    const channels = [
      ch('a', { key_env: 'VK_SAME_KEY' }),
      ch('b', { key_env: 'VK_OTHER_KEY' }),
      ch('c', { key_env: 'VK_SAME_KEY' }),
    ]

    expect(sharedKeyPeers(channels[0], channels)).toEqual(['c'])
    expect(sharedKeyPeers(channels[1], channels)).toEqual([])
  })

  test('旧版引擎没有字段:key_env 不同但长 key 的打码相同也算共用', () => {
    const channels = [
      ch('a', { key_masked: LONG_MASK }),
      ch('b', { key_masked: LONG_MASK }),
      ch('c', { key_masked: 'sk-othe••••••••••4321' }),
    ]

    expect(sharedKeyPeers(channels[0], channels)).toEqual(['b'])
    expect(sharedKeyPeers(channels[2], channels)).toEqual([])
  })

  test('旧版引擎没有字段:短 key 的打码相同不识别', () => {
    const channels = [ch('a', { key_masked: SHORT_MASK }), ch('b', { key_masked: SHORT_MASK })]

    expect(sharedKeyPeers(channels[0], channels)).toEqual([])
  })

  test('旧版引擎没有字段:空 key_env 和空打码不算相同', () => {
    const channels = [ch('a', { key_env: '' }), ch('b', { key_env: '' })]

    expect(sharedKeyPeers(channels[0], channels)).toEqual([])
  })
})

describe('sharedKeyGroups', () => {
  test('旧版引擎下同 key_env 的通道成组', () => {
    const channels = [ch('a', { key_env: 'VK_SAME_KEY' }), ch('b'), ch('c', { key_env: 'VK_SAME_KEY' })]

    expect(sharedKeyGroups(channels, live('a', 'b', 'c'))).toEqual([{ id: 'a|c', ids: ['a', 'c'], names: ['A', 'C'] }])
  })

  test('新版引擎按字段成组,按通道首次出现的顺序', () => {
    const channels = [
      ch('a', { key_shared_with: ['b'] }),
      ch('b', { key_shared_with: ['a'] }),
      ch('c', { key_shared_with: ['d'] }),
      ch('d', { key_shared_with: ['c'] }),
    ]

    expect(sharedKeyGroups(channels, live('a', 'b', 'c', 'd')).map((group) => group.id)).toEqual(['a|b', 'c|d'])
  })

  test('旧版引擎下没有任何共用时不分组', () => {
    expect(sharedKeyGroups([ch('a'), ch('b')], live('a', 'b'))).toEqual([])
  })

  test('只算仍在列表里的通道', () => {
    const channels = [ch('a', { key_shared_with: ['b'] }), ch('b', { key_shared_with: ['a'] })]

    expect(sharedKeyGroups(channels, live('a'))).toEqual([])
  })
})

describe('sharedKeyGroupTitle', () => {
  test('两条写成「A」和「B」,三条以上写成「A」、「B」和「C」', () => {
    expect(sharedKeyGroupTitle(['A', 'B'])).toBe('「A」和「B」用的是同一把 key：中转站可能一次只处理一条；key 被限流或余额不足时，它们会一起不可用。')
    expect(sharedKeyGroupTitle(['A', 'B', 'C'])).toMatch(/^「A」、「B」和「C」用的是同一把 key/)
  })
})
