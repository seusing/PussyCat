import { Eye } from 'lucide-react'
import { vkResultVersionLabel, type VkTaskResultGroup } from './taskResults'
import './VkResultActions.css'

export function VkResultActions({ groups, onOpen }: {
  groups: readonly VkTaskResultGroup[]
  onOpen: (versionJobId?: string) => void
}) {
  if (!groups.some((group) => group.versions.length > 0)) return null
  const options = (group: VkTaskResultGroup) => group.versions.map((version, index) => (
    <option key={version.jobId} value={version.jobId}>
      {vkResultVersionLabel(version, index === 0)}
    </option>
  ))
  return (
    <div className="vk-result-actions">
      <button type="button" className="vk-task-open-output-button" onClick={() => onOpen()}>
        <Eye size={14} aria-hidden="true" />
        <span>查看解析结果</span>
      </button>
      {groups.some((group) => group.versions.length > 1) && (
        <select
          aria-label="查看历史结果"
          value=""
          onChange={(event) => {
            if (event.target.value) onOpen(event.target.value)
            event.target.value = ''
          }}
        >
          <option value="" disabled>历史版本</option>
          {groups.length > 1
            ? groups.filter((group) => group.versions.length > 0).map((group) => (
              <optgroup key={group.id} label={`小任务${group.ordinal}`}>{options(group)}</optgroup>
            ))
            : groups.map(options)}
        </select>
      )}
    </div>
  )
}
