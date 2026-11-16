import { useId } from 'react'
import type { ManifestArg } from '../../data/types'
import { inputKind } from '../../data/inputKind'
import { argHelp, choiceLabel } from '../../data/zhCopy'
import { GlassSelect } from '../../components/GlassMenu'
import { InfoTip } from '../../components/InfoTip'

/** 中文说明在第一个「，」或「；」处断开:前半句作标签,其余收进 ⓘ。英文原文不断开。 */
function splitHelp(help: string | undefined): [string | undefined, string | undefined] {
  if (!help) return [undefined, undefined]
  const at = help.search(/[，；]/)
  return at > 0 ? [help.slice(0, at), help.slice(at + 1)] : [help, undefined]
}

export function DynamicField({ arg, value, error, onChange, commandKey }: {
  arg: ManifestArg; value: unknown; error?: string; onChange: (v: unknown) => void; commandKey?: string
}) {
  const kind = inputKind(arg)
  // 标签里还有 ⓘ 按钮:用 htmlFor 显式指向控件,否则点标签会落到 ⓘ 上。
  const controlId = useId()
  // 参数说明**逐参数**回落:一条命令译了 description 不代表每个参数都译了(见 data/zhCopy.ts)。
  // commandKey 缺省时直接用原文——本组件也被无上下文地单独渲染过。
  const help = commandKey ? argHelp(commandKey, arg.name, arg.help) : arg.help

  // 有 default 时提交会补上默认值,不需要「不指定」;没有 default 才给一个空选项。
  const emptyOption = arg.default !== undefined ? [] : [{ value: '', label: '不指定' }]

  // 整行字段(text、开关磁贴)标题不截断;格子里的 select/number 标题最多两行,完整说明在 ⓘ 里。
  const fullWidth = kind === 'text' || kind === 'switch'

  const [helpLabel, helpMore] = splitHelp(help)
  const labelRow = (
    <span data-testid={`field-label-${arg.name}`} className="cmd-field-label-row">
      <span className="cmd-field-title" title={!fullWidth && helpLabel ? helpLabel : undefined}>
        {helpLabel ? <span data-testid={`field-help-${arg.name}`}>{helpLabel}</span> : arg.name}
        {arg.required && <span className="cmd-field-required"> *</span>}
      </span>
      {helpLabel && (
        <InfoTip label={`${helpLabel}说明`} className="cmd-field-info">
          {helpMore && <p>{helpMore}</p>}
          <p>参数名 <code>{arg.name}</code></p>
        </InfoTip>
      )}
    </span>
  )

  const errorText = error && <span data-testid={`error-${arg.name}`} className="cmd-field-error">{error}</span>

  // 布尔参数是整行磁贴:标签在左、拨动开关在右,整块都在 <label> 内,点哪里都切换。
  if (kind === 'switch') {
    return (
      <label className="cmd-field cmd-field--full" htmlFor={controlId}>
        <span className="cmd-field-tile">
          {labelRow}
          <span className="cmd-field-switch-wrap">
            <input
              id={controlId}
              data-testid={`field-${arg.name}`}
              type="checkbox"
              className="cmd-field-switch-input"
              checked={value === true}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span className="cmd-field-switch-track" aria-hidden="true">
              <span className="cmd-field-switch-thumb" />
            </span>
          </span>
        </span>
        {errorText}
      </label>
    )
  }

  return (
    <label className={`cmd-field${fullWidth ? ' cmd-field--full' : ''}`} htmlFor={controlId}>
      {labelRow}

      {kind === 'select' ? (
        <GlassSelect
          id={controlId}
          data-testid={`field-${arg.name}`}
          aria-label={arg.name}
          aria-invalid={!!error}
          className="cmd-field-control"
          value={String(value ?? '')}
          onChange={onChange}
          options={[
            ...emptyOption,
            ...(arg.choices ?? []).map((ch) => ({
              value: typeof ch === 'string' ? ch : ch.value,
              label: typeof ch === 'string'
                ? (commandKey ? choiceLabel(commandKey, arg.name, ch) : ch)
                : ch.label,
            })),
          ]}
        />
      ) : (
        <input
          id={controlId}
          data-testid={`field-${arg.name}`}
          className="cmd-field-control"
          aria-invalid={!!error}
          type={kind === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
          onChange={(e) => onChange(kind === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
        />
      )}

      {errorText}
    </label>
  )
}
