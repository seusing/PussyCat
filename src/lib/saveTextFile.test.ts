import { beforeEach, describe, expect, it, vi } from 'vitest'
import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { saveTextFileAs } from './saveTextFile'

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: vi.fn() }))

describe('saveTextFileAs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes the result to the path selected by the user', async () => {
    vi.mocked(save).mockResolvedValue('C:\\Users\\tester\\result.md')

    await expect(saveTextFileAs('result.md', '# 结果')).resolves.toBe(true)

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'result.md' }))
    expect(writeTextFile).toHaveBeenCalledWith('C:\\Users\\tester\\result.md', '# 结果')
  })

  it('does nothing when the save dialog is cancelled', async () => {
    vi.mocked(save).mockResolvedValue(null)

    await expect(saveTextFileAs('result.md', '# 结果')).resolves.toBe(false)
    expect(writeTextFile).not.toHaveBeenCalled()
  })

  it('can cancel the prepared download before anything is written', async () => {
    vi.useFakeTimers()
    vi.mocked(save).mockResolvedValue('C:\\Users\\tester\\result.md')
    const controller = new AbortController()
    const progress = vi.fn()

    const saving = saveTextFileAs('result.md', '# 结果'.repeat(200), {
      signal: controller.signal,
      onProgress: progress,
    })
    await Promise.resolve()
    controller.abort()
    await vi.runAllTimersAsync()

    await expect(saving).resolves.toBe(false)
    expect(progress).toHaveBeenCalledWith(0)
    expect(writeTextFile).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
