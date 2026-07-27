import { createHash } from 'node:crypto'

export const POLICY_SCHEMA_VERSION = 1

/**
 * 对象键排序、数组保序的规范化 JSON——哈希的单射前提。
 * **仅适用于纯 JSON 值**(经 `JSON.parse` 或字面量构造的 object/array/string/number/boolean/null)。
 * 实测:`undefined` 与显式 `null` 会坍缩成同一个值(`value ?? null`);`Date`/`Map`/`Set`
 * 因为没有自有可枚举属性,会被序列化成 `{}`——两个不同的 `Date` 会产出完全相同的结果。
 * 当前调用点都来自 `JSON.parse` 或字面量,不会撞到这两个坑,但 Task 5 打算复用本函数
 * 算 revision,届时若传入非纯 JSON 值,值得留意。
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

// arg 的**行为投影**(spec §5)。实测 arg 字段全集为
// choices/default/help/name/positional/required/type/valueRequired,其中只有 help 是纯展示。
// default 尤其要进:buildTokens 不直接读它,但 appStore.ts 用它播种表单 values、
// command.ts 用它决定布尔标志是否发 `--flag false`,所以它经 values 改变实际提交的 argv。
// **不含 `positional`**:它的语义已由下面 reviewShapeHash 的 positionalArgs/flagArgs 分桶
// 独立承载(改了 positional 就换桶,哈希必变)。放在这里是冗余的第二份,而且**没有任何测试
// 能区分它在不在** —— 实测:从本函数删掉 positional,全部用例仍绿。
// 沿用本仓已立的规矩:没有任何测试能区分的东西会在后人手里烂掉,该删而不是硬凑一个测试。
function argProjection(arg) {
  return {
    name: arg.name ?? null,
    type: arg.type ?? null,
    required: arg.required ?? false,
    valueRequired: arg.valueRequired ?? null,
    default: arg.default ?? null,
    choices: arg.choices ?? null,
  }
}

/**
 * 审定形状哈希：它变了说明**人工审定该重做**（不只是让用户再确认一次）。
 * 含 opencliVersion——实现变了而 manifest 没变时旧审定必须失效
 * （`paperreview/review` 就是活例:返回体带 token 这件事根本不在 manifest 里）。
 */
export function reviewShapeHash(command, opencliVersion) {
  const args = command.args ?? []
  return createHash('sha256').update(canonicalJson({
    opencliVersion,
    commandKey: command.command,
    access: command.access ?? null,
    strategy: command.strategy ?? null,
    browser: command.browser ?? null,
    siteSession: command.siteSession ?? null,
    modulePath: command.modulePath ?? null,     // 换实现文件 = 换实现
    domain: command.domain ?? null,             // 数据去向
    navigateBefore: command.navigateBefore ?? null,
    defaultWindowMode: command.defaultWindowMode ?? null,
    defaultFormat: command.defaultFormat ?? null,
    type: command.type ?? null,
    // 位置参数**保留声明顺序**——顺序是语义;flag 按 name 归一化——顺序无语义。
    positionalArgs: args.filter((a) => a.positional).map(argProjection),
    flagArgs: args.filter((a) => !a.positional).map(argProjection)
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    columns: command.columns ?? null,           // 只作审定漂移信号
  })).digest('hex')
}

// spec §3.1 把 authorities/effects/residues 定义为**集合**,§4.3 第 8 步明写「按值比较,
// 非引用/非顺序」——与 policy-types.mjs 的 isSubsetOf 对同一批字段的语义一致。
// canonicalJson 对数组**刻意保序**(positionalArgs 需要顺序敏感),所以不能让 canonicalJson
// 本身变成顺序无关;必须在喂给它之前,把这三个集合字段单独排序归一化。
// residues 的类型是 `'unknown' | Array<...>`(spec §3.1),字符串分支原样透传,不排序。
function sortIfArray(value) {
  return Array.isArray(value) ? [...value].sort() : value
}

function normalizeSetFields(metadata) {
  if (!metadata || typeof metadata !== 'object') return metadata
  return {
    ...metadata,
    authorities: sortIfArray(metadata.authorities),
    effects: sortIfArray(metadata.effects),
    residues: sortIfArray(metadata.residues),
  }
}

/**
 * 判决指纹：它变了说明**用户该重新确认**（审定本身可能仍然有效）。
 * matchedDenyRule 只放**该命令实际命中的**规则——用全局 denyRevision 会让
 * 无关命令的 deny 变化作废全部确认。
 * metadata 在入哈希前先经 normalizeSetFields——否则同一集合仅字面量顺序不同就会
 * 产出不同指纹,让已确认的 acknowledgement 无端失效。
 */
export function decisionFingerprint({ policySchemaVersion, reviewShapeHash: shape, metadata, matchedDenyRule }) {
  return createHash('sha256').update(canonicalJson({
    policySchemaVersion, reviewShapeHash: shape, metadata: normalizeSetFields(metadata), matchedDenyRule: matchedDenyRule ?? null,
  })).digest('hex')
}
