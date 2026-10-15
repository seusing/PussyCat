import { KNOWN_TERMS_KEY, KNOWN_TERMS_MAX, addKnownTerm, loadKnownTerms, normalizeTerm } from './knownTerms'

function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  }
}

test('normalizeTerm 做 NFKC、去空白并把拉丁字母转小写', () => {
  expect(normalizeTerm('  ＲＰＥ ')).toBe('rpe')
  expect(normalizeTerm('Progressive Overload')).toBe('progressive overload')
  expect(normalizeTerm('渐进式超负荷')).toBe('渐进式超负荷')
})

test('空存储读出空集合', () => {
  expect(loadKnownTerms(fakeStorage()).size).toBe(0)
})

test('add→load 往返,按规范化后的写法存取并去重', () => {
  const s = fakeStorage()
  expect(addKnownTerm('RPE', s)).toBe(true)
  expect(addKnownTerm('rpe', s)).toBe(true)
  expect(addKnownTerm('减载', s)).toBe(true)
  expect([...loadKnownTerms(s)]).toEqual(['rpe', '减载'])
  expect(JSON.parse(s.getItem(KNOWN_TERMS_KEY)!)).toEqual(['rpe', '减载'])
})

test('重复添加把术语挪到最新位置', () => {
  const s = fakeStorage()
  addKnownTerm('甲', s)
  addKnownTerm('乙', s)
  addKnownTerm('甲', s)
  expect([...loadKnownTerms(s)]).toEqual(['乙', '甲'])
})

test('只保留最新的 500 个', () => {
  const s = fakeStorage()
  s.setItem(KNOWN_TERMS_KEY, JSON.stringify(Array.from({ length: KNOWN_TERMS_MAX }, (_, i) => `术语${i}`)))
  addKnownTerm('新术语', s)
  const terms = [...loadKnownTerms(s)]
  expect(terms).toHaveLength(KNOWN_TERMS_MAX)
  expect(terms[0]).toBe('术语1')
  expect(terms.at(-1)).toBe('新术语')
})

test('空白术语不写入', () => {
  const s = fakeStorage()
  expect(addKnownTerm('   ', s)).toBe(false)
  expect(s.getItem(KNOWN_TERMS_KEY)).toBeNull()
})

test('存储里的坏数据读成空集合,非字符串项被丢弃', () => {
  const s = fakeStorage()
  s.setItem(KNOWN_TERMS_KEY, '{坏')
  expect(loadKnownTerms(s).size).toBe(0)
  s.setItem(KNOWN_TERMS_KEY, '{"a":1}')
  expect(loadKnownTerms(s).size).toBe(0)
  s.setItem(KNOWN_TERMS_KEY, JSON.stringify(['减载', 3, null]))
  expect([...loadKnownTerms(s)]).toEqual(['减载'])
})

test('存储读写抛错时兜底,不影响调用方', () => {
  const broken = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('quota') },
  } as unknown as Storage
  expect(loadKnownTerms(broken).size).toBe(0)
  expect(addKnownTerm('减载', broken)).toBe(false)
})

test('不传 storage 时用全局 localStorage', () => {
  expect(addKnownTerm('减载')).toBe(true)
  expect(loadKnownTerms().has('减载')).toBe(true)
})
