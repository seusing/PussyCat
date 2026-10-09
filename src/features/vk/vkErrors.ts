import { HostRequestError } from '../../host/errors'
import { isVkEngineNotReady } from '../../host/vkClient'

export const ENGINE_NOT_READY_TEXT = '解析引擎还没准备好，请先在视频解析页完成一键准备'

/** 给用户看的 text,以及供排障的 title(宿主原文与 reasonCode,不进正文)。 */
export type VkErrorNote = { text: string; title?: string }

export function vkErrorNote(error: unknown, fallback: string): VkErrorNote {
  if (error instanceof HostRequestError) {
    const original = error.reasonCode ? `${error.summary}(${error.reasonCode})` : error.summary
    if (isVkEngineNotReady(error)) return { text: ENGINE_NOT_READY_TEXT, title: original }
    return { text: error.summary || fallback, title: error.reasonCode ? original : undefined }
  }
  if (error instanceof Error) return { text: error.message || fallback }
  return { text: fallback }
}

export function vkErrorText(error: unknown, fallback: string): string {
  return vkErrorNote(error, fallback).text
}
