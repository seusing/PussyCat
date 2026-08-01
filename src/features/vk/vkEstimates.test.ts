import { estimateForPreset, formatEstimate } from './vkEstimates'

describe('estimateForPreset', () => {
  it('returns the M0-measured range for the four known presets', () => {
    for (const preset of ['quick-summary', 'course-learning', 'interview-analysis', 'science-explainer']) {
      const estimate = estimateForPreset(preset)
      expect(estimate.costRangeCny).toEqual([0.25, 1.06])
      expect(estimate.durationRangeMin).toEqual([8.3, 27.4])
      expect(estimate.basis).toContain('M0')
      expect(estimate.unknownReason).toBeUndefined()
    }
  })

  it('returns unknown with a reason for presets without measured samples', () => {
    const estimate = estimateForPreset('legacy-ingest')
    expect(estimate.costRangeCny).toBeNull()
    expect(estimate.durationRangeMin).toBeNull()
    expect(estimate.unknownReason).toContain('legacy-ingest')
  })

  it('formats known ranges and unknown reasons', () => {
    expect(formatEstimate(estimateForPreset('quick-summary')).cost).toBe('¥0.25 – ¥1.06')
    expect(formatEstimate(estimateForPreset('quick-summary')).duration).toBe('8.3 – 27.4 分钟')
    expect(formatEstimate(estimateForPreset('mystery')).cost).toContain('unknown')
    expect(formatEstimate(estimateForPreset('mystery')).cost).toContain('mystery')
  })
})
