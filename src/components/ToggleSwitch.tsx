import type { ReactNode } from 'react'
import './ToggleSwitch.css'

/**
 * 胶囊开关:隐藏的 checkbox 承担键盘与读屏,轨道和滑块只负责外观。
 * tone 决定「开」的颜色;indicator 是轨道右上角的红/绿状态小点。
 */
export function ToggleSwitch({ checked, onChange, label, ariaLabel, tone = 'accent', indicator = false, testId, className = '', children }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  /** label 不是纯文字(比如带切换动画)时,给读屏一个稳定的名字。 */
  ariaLabel?: string
  tone?: 'accent' | 'success'
  indicator?: boolean
  testId?: string
  className?: string
  /** 放在开关右边、仍属于这个 label 的内容。 */
  children?: ReactNode
}) {
  return (
    <label className={`toggle-switch is-${tone} ${className}`.trim()}>
      <span>{label}</span>
      <input
        data-testid={testId}
        className="toggle-switch-input"
        type="checkbox"
        role="switch"
        aria-label={ariaLabel}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-switch-track" aria-hidden="true">
        {indicator && <span className="toggle-switch-indicator" />}
        <span className="toggle-switch-thumb" />
      </span>
      {children}
    </label>
  )
}
