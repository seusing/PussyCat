import { collectNoteLinks } from './noteLinks'

describe('collectNoteLinks', () => {
  it('deduplicates URLs and separates explicit videos from image/text notes', () => {
    expect(collectNoteLinks([
      { type: 'video', url: ' https://example.com/video ' },
      { type: 'normal', url: 'https://example.com/image' },
      { video_url: 'https://example.com/video', url: 'https://example.com/video' },
    ])).toEqual({
      video: ['https://example.com/video'],
      imageText: ['https://example.com/image'],
      all: ['https://example.com/video', 'https://example.com/image'],
    })
  })

  it('keeps unknown note types in the image/text group instead of guessing video', () => {
    expect(collectNoteLinks([{ type: 'normal', url: 'https://example.com/note' }]).imageText)
      .toEqual(['https://example.com/note'])
  })
})
