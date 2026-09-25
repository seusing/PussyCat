import { Eye } from 'lucide-react'
import { vkResultVersionLabel, type VkTaskResultGroup } from './taskResults'
import { GlassSelect, type GlassOption } from '../../components/GlassMenu'
import './VkResultActions.css'

export function VkResultActions({ groups, onOpen }: {
  groups: readonly VkTaskResultGroup[]
  onOpen: (versionJobId?: string) => void
}) {
  if (!groups.some((group) => group.versions.length > 0)) return null
  const options = (group: VkTaskResultGroup): GlassOption[] => group.versions.map((version, index) => ({
    value: version.jobId,
    label: vkResultVersionLabel(version, index === 0),
    group: groups.length > 1 ? `小任务${group.ordinal}` : undefined,
  }))
  return (
    <div className="vk-result-actions">
      <button type="button" className="vk-task-open-output-button" onClick={() => onOpen()}>
        <Eye size={14} aria-hidden="true" />
        <span>查看解析结果</span>
      </button>
      {groups.some((group) => group.versions.length > 1) && (
        <GlassSelect
          aria-label="查看历史结果"
          value=""
          onChange={(value) => {
            if (value) onOpen(value)
          }}
          options={[
            { value: '', label: '历史版本', disabled: true },
            ...groups.filter((group) => group.versions.length > 0).flatMap(options),
          ]}
        />
      )}
    </div>
  )
}
