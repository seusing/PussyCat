// 费用/耗时估算(拍板 5.5:提交前必须告知;缺数据显示 unknown 及原因)。
//
// 数据来源:vk 仓 docs/M0-ACCEPTANCE.md 真机三集实测(2026-07)——
// 中文课程 68min → 27.4min / ¥1.06;英文科普 16min → 16.8min / ¥0.25;
// 中文访谈 34min → 8.3min / ¥0.46。逐条视频无法先验预估,这是区间告知不是承诺。
export interface VkEstimate {
  costRangeCny: [number, number] | null
  durationRangeMin: [number, number] | null
  basis: string
  unknownReason?: string
}

const KNOWN_PRESETS = new Set([
  'course-learning',
  'interview-analysis',
  'science-explainer',
  'quick-summary',
])

const M0_BASIS = '基于 vk M0 真机三集实测(2026-07)的区间;逐条视频无法先验预估,估算不是承诺'

export function estimateForPreset(preset: string): VkEstimate {
  if (KNOWN_PRESETS.has(preset)) {
    return {
      costRangeCny: [0.25, 1.06],
      durationRangeMin: [8.3, 27.4],
      basis: M0_BASIS,
    }
  }
  return {
    costRangeCny: null,
    durationRangeMin: null,
    basis: M0_BASIS,
    unknownReason: `preset「${preset}」没有历史实测样本`,
  }
}

export function formatEstimate(estimate: VkEstimate): { cost: string; duration: string } {
  return {
    cost: estimate.costRangeCny
      ? `¥${estimate.costRangeCny[0].toFixed(2)} – ¥${estimate.costRangeCny[1].toFixed(2)}`
      : `unknown(${estimate.unknownReason ?? '无估算数据'})`,
    duration: estimate.durationRangeMin
      ? `${estimate.durationRangeMin[0]} – ${estimate.durationRangeMin[1]} 分钟`
      : `unknown(${estimate.unknownReason ?? '无估算数据'})`,
  }
}
