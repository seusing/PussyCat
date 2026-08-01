import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VkCostConfirmDialog } from './VkCostConfirmDialog'
import { estimateForPreset } from './vkEstimates'
import type { VkProcessingRequest } from '../../host/vkClient'

function request(overrides: Partial<VkProcessingRequest> = {}): VkProcessingRequest {
  return {
    schema_version: '1.1.0',
    source: 'https://example.com/v',
    intent: 'summarize',
    preset: 'quick-summary',
    preset_version: '1.0.0',
    content_type: 'auto',
    media_policy: 'audio_transcript',
    output_targets: ['markdown_note'],
    language: 'auto',
    quality_profile: 'fast',
    budget_profile: 'economy',
    provider_profile: 'default',
    audit_requested: false,
    requested_capabilities: [],
    user_metadata: {},
    max_cost_cny: null,
    ...overrides,
  }
}

describe('VkCostConfirmDialog', () => {
  it('renders nothing without a pending submit', () => {
    const { container } = render(
      <VkCostConfirmDialog pending={null} onConfirm={() => {}} onCancel={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows estimates, the not-a-promise line, and the cost cap', () => {
    render(
      <VkCostConfirmDialog
        pending={{ request: request({ max_cost_cny: 2.5 }), estimate: estimateForPreset('quick-summary') }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByTestId('vk-cost-estimate').textContent).toBe('¥0.25 – ¥1.06')
    expect(screen.getByTestId('vk-duration-estimate').textContent).toBe('8.3 – 27.4 分钟')
    expect(screen.getByTestId('vk-cost-cap').textContent).toContain('¥2.5')
    expect(screen.getByTestId('vk-cost-dialog').textContent).toContain('估算不是承诺')
    expect(screen.getByTestId('vk-cost-dialog').textContent).toContain('不提供"记住选择"')
  })

  it('shows unknown estimates with the reason instead of hiding them', () => {
    render(
      <VkCostConfirmDialog
        pending={{ request: request({ preset: 'mystery' }), estimate: estimateForPreset('mystery') }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByTestId('vk-cost-estimate').textContent).toContain('unknown')
    expect(screen.getByTestId('vk-cost-estimate').textContent).toContain('mystery')
  })

  it('fires confirm and cancel callbacks', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <VkCostConfirmDialog
        pending={{ request: request(), estimate: estimateForPreset('quick-summary') }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    await user.click(screen.getByTestId('vk-cost-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId('vk-cost-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
