import { findRowUrl } from '../vk/findRowUrl'

export type NoteLinkGroups = {
  video: string[]
  imageText: string[]
  all: string[]
}

const TYPE_KEYS = ['type', 'note_type', 'media_type', 'content_type', 'kind']

function hasVideoSignal(row: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(row)) {
    const keyName = key.toLowerCase()
    if (keyName.includes('video') || keyName.includes('play')) return true
    if (!TYPE_KEYS.includes(keyName) || typeof value !== 'string') continue
    const text = value.toLowerCase()
    if (text.includes('video') || text.includes('视频')) return true
  }
  return false
}

/** Extract note URLs once, preserving result order and classifying only explicit video signals. */
export function collectNoteLinks(rows: Record<string, unknown>[]): NoteLinkGroups {
  const video: string[] = []
  const imageText: string[] = []
  const all: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const found = findRowUrl(row)
    if (!found || seen.has(found.url)) continue
    seen.add(found.url)
    all.push(found.url)
    if (hasVideoSignal(row)) video.push(found.url)
    else imageText.push(found.url)
  }
  return { video, imageText, all }
}
