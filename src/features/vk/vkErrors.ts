import { HostRequestError } from '../../host/errors'
import { isVkEngineNotReady } from '../../host/vkClient'

export const ENGINE_NOT_READY_TEXT = '解析引擎还没准备好，请先在视频解析页完成一键准备'
export const SESSION_REACQUIRE_TEXT = '链接里的访问凭据没有保存，无法直接重跑：请回到采集结果重新导出链接，作为新任务提交'

/** 给用户看的 text,以及供排障的 title(宿主原文与 reasonCode,不进正文)。 */
export type VkErrorNote = { text: string; title?: string }

export function vkErrorNote(error: unknown, fallback: string): VkErrorNote {
  if (error instanceof HostRequestError) {
    const original = error.reasonCode ? `${error.summary}(${error.reasonCode})` : error.summary
    if (isVkEngineNotReady(error)) return { text: ENGINE_NOT_READY_TEXT, title: original }
    if (error.reasonCode === 'session-reacquire-required') return { text: SESSION_REACQUIRE_TEXT, title: original }
    return { text: error.summary || fallback, title: error.reasonCode ? original : undefined }
  }
  if (error instanceof Error) return { text: error.message || fallback }
  return { text: fallback }
}

export function vkErrorText(error: unknown, fallback: string): string {
  return vkErrorNote(error, fallback).text
}

// 模型两次输出都过不了格式校验时,引擎的阶段失败原文形如「storyline_reduce 两次输出均不可用…」。
const OUTPUT_UNUSABLE = /^(\w+) 两次输出均不可用/
const OUTPUT_UNUSABLE_CONSEQUENCE: Record<string, string> = {
  storyline_reduce: '，这条故事线只保留了各集摘要，可以点「串联分析」重新生成',
  comparison_reduce: '，这组观点对比没有生成',
  series_digest: '，这个视频改用简化摘要参与串联',
  storyline_link: '，这一组视频的关系没有判定出来',
}

/** 认得出的阶段失败原文翻成人话,原文进 title 供排查;认不出返回 null,由调用方走通用失败说明。 */
export function vkStageFailureNote(raw: string): VkErrorNote | null {
  const match = OUTPUT_UNUSABLE.exec(raw.trim())
  if (!match) return null
  return { text: `模型两次都没有按格式返回${OUTPUT_UNUSABLE_CONSEQUENCE[match[1]] ?? ''}`, title: raw }
}
