export type AccessKind = 'read' | 'write'

export type ManifestArg = {
  name: string
  type: 'str' | 'string' | 'int' | 'number' | 'float' | 'bool' | 'boolean'
  required?: boolean
  help?: string
  default?: string | number | boolean
  choices?: Array<string | { label: string; value: string }>
  positional?: boolean
  valueRequired?: boolean
}

export type CommandManifest = {
  command: string            // "site/name"，list 主键
  site: string
  name: string
  description: string
  access: AccessKind
  strategy?: string
  browser: boolean
  args: ManifestArg[]
  columns?: string[]
  domain?: string
  aliases?: string[]
  example?: string
  defaultFormat?: string
  // 由包内 manifest 补映射：
  navigateBefore?: boolean | string
  defaultWindowMode?: 'foreground' | 'background' | string
  type?: string
  modulePath?: string
}

export type CatalogSnapshot = {
  schemaVersion: 1
  generatedAt: number
  opencliVersion: string
  source: string
  listSha256: string
  manifestSha256: string
  commands: CommandManifest[]
}

export type InputKind = 'text' | 'number' | 'switch' | 'select'
