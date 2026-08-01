import { findRowUrl } from './findRowUrl'

describe('findRowUrl', () => {
  it('prefers priority keys over incidental string values', () => {
    const row = {
      title: 'https://decoy.example/a',
      url: ' https://real.example/v ',
    }
    expect(findRowUrl(row)).toEqual({ url: 'https://real.example/v', column: 'url' })
  })

  it('falls back to scanning any string value', () => {
    const row = { rank: 1, bvid: 'BV1xx', open: 'https://example.com/watch?v=1' }
    expect(findRowUrl(row)).toEqual({ url: 'https://example.com/watch?v=1', column: 'open' })
  })

  it('returns null when nothing looks like a URL', () => {
    expect(findRowUrl({ title: '标题', rank: 3, note: 'ftp://nope' })).toBeNull()
  })
})
