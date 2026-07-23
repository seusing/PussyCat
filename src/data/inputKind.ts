import type { ManifestArg, InputKind } from './types'

export function inputKind(arg: ManifestArg): InputKind {
  if (arg.choices?.length) return 'select'
  if (arg.type === 'bool' || arg.type === 'boolean') return 'switch'
  if (arg.type === 'int' || arg.type === 'number' || arg.type === 'float') return 'number'
  return 'text'
}
