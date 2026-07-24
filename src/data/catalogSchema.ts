import type { CommandManifest } from './types'

export class CatalogSchemaError extends Error {}

const isStr = (x: unknown): x is string => typeof x === 'string'

function assertArg(a: unknown, key: string): void {
  const o = a as { name?: unknown; type?: unknown; choices?: unknown }
  if (!o || typeof o !== 'object' || !isStr(o.name) || !isStr(o.type)) {
    throw new CatalogSchemaError(`命令 ${key} 的参数元素非法`)
  }
  if (o.choices !== undefined) {
    if (!Array.isArray(o.choices)) throw new CatalogSchemaError(`命令 ${key} 参数 ${String(o.name)} 的 choices 非数组`)
    for (const c of o.choices) {
      const ok = isStr(c) || (!!c && typeof c === 'object' && isStr((c as { label?: unknown }).label) && isStr((c as { value?: unknown }).value))
      if (!ok) throw new CatalogSchemaError(`命令 ${key} 参数 ${String(o.name)} 的 choices 元素非法`)
    }
  }
}

// 深校验(三轮复审 F2):元素级 args/choices + key 一致性 + 重复 command 拒绝。
// 与块 A preferences 的「坏项丢弃」不同——catalog 是单一生成器产物,结构异常=生成端 bug,
// 应 fail-loud(服务端原子替换保旧值,前端首载走错误屏/刷新走失败提示)。
export function assertCatalogCommands(commands: unknown): asserts commands is CommandManifest[] {
  if (!Array.isArray(commands) || commands.length === 0) throw new CatalogSchemaError('commands 为空或非数组')
  const seen = new Set<string>()
  for (const c of commands) {
    const o = c as CommandManifest
    if (!o || typeof o !== 'object' || !isStr(o.command) || !isStr(o.site) || !isStr(o.name) || !('access' in o) || !Array.isArray(o.args)) {
      throw new CatalogSchemaError(`命令字段缺失：${(o && o.command) || '?'}`)
    }
    if (o.command !== `${o.site}/${o.name}`) throw new CatalogSchemaError(`命令 key 不一致：${o.command} != ${o.site}/${o.name}`)
    if (seen.has(o.command)) throw new CatalogSchemaError(`命令 key 重复：${o.command}`)
    seen.add(o.command)
    for (const a of o.args) assertArg(a, o.command)
  }
}
