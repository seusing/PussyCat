import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'

export type SaveTextFileOptions = {
  signal?: AbortSignal
  onProgress?: (progress: number) => void
}

function extensionOf(fileName: string): string {
  const match = fileName.match(/\.([A-Za-z0-9]+)$/)
  return match?.[1]?.toLowerCase() ?? 'md'
}

async function prepareContent(
  content: string,
  { signal, onProgress }: SaveTextFileOptions,
): Promise<string | null> {
  if (!onProgress) return signal?.aborted ? null : content

  const steps = Math.min(12, Math.max(1, content.length))
  const chunkSize = Math.max(1, Math.ceil(content.length / steps))
  let prepared = ''
  onProgress(0)
  for (let offset = 0; offset < content.length || (content.length === 0 && offset === 0); offset += chunkSize) {
    if (signal?.aborted) return null
    prepared += content.slice(offset, offset + chunkSize)
    const consumed = content.length === 0 ? 1 : Math.min(content.length, offset + chunkSize)
    const total = Math.max(1, content.length)
    onProgress(Math.min(90, Math.round((consumed / total) * 90)))
    await new Promise((resolve) => setTimeout(resolve, 45))
    if (content.length === 0) break
  }
  return signal?.aborted ? null : prepared
}

export async function saveTextFileAs(
  defaultFileName: string,
  content: string,
  options: SaveTextFileOptions = {},
): Promise<boolean> {
  const extension = extensionOf(defaultFileName)
  const path = await save({
    title: '保存解析结果',
    defaultPath: defaultFileName,
    filters: [{
      name: extension === 'json' ? 'JSON 文件' : 'Markdown 文件',
      extensions: [extension],
    }],
  })
  if (!path) return false
  const prepared = await prepareContent(content, options)
  if (prepared === null) return false
  await writeTextFile(path, prepared)
  options.onProgress?.(100)
  return true
}
