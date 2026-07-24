import { copyText } from './clipboard'

test('navigator.clipboard.writeText 成功 → true', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  expect(await copyText('hi')).toBe(true)
  expect(writeText).toHaveBeenCalledWith('hi')
})

test('writeText 缺失 → 走 execCommand fallback', async () => {
  vi.stubGlobal('navigator', {})
  const exec = vi.fn().mockReturnValue(true)
  ;(document as Document & { execCommand?: typeof exec }).execCommand = exec
  expect(await copyText('hi')).toBe(true)
  expect(exec).toHaveBeenCalledWith('copy')
})

test('writeText reject → 走 fallback', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
  const exec = vi.fn().mockReturnValue(true)
  ;(document as Document & { execCommand?: typeof exec }).execCommand = exec
  expect(await copyText('hi')).toBe(true)
})

test('两路全败 → false', async () => {
  vi.stubGlobal('navigator', {})
  ;(document as Document & { execCommand?: () => boolean }).execCommand = () => { throw new Error('nope') }
  expect(await copyText('hi')).toBe(false)
})
