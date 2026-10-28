export function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

export function mergeManifestFields(list, manifest) {
  const byKey = new Map()
  for (const m of manifest) byKey.set(`${m.site}/${m.name}`, m)
  return list.map((cmd) => {
    const m = byKey.get(`${cmd.site}/${cmd.name}`)
    if (!m) return cmd
    return {
      ...cmd,
      navigateBefore: cmd.navigateBefore ?? m.navigateBefore,
      defaultWindowMode: cmd.defaultWindowMode ?? m.defaultWindowMode,
      type: cmd.type ?? m.type,
      modulePath: cmd.modulePath ?? m.modulePath,
    }
  })
}

// OpenCLI 2.0 的 `list -f json` 不再给完整数组,而是 {ok,data:{commands,total,nextOffset}} 分页,
// 条目只有 command("站点 命令")/description/access;参数等字段要回 cli-manifest.json 取。
const LIST_PAGE_LIMIT = 100

function parseListPage(raw) {
  let parsed
  try {
    parsed = JSON.parse(stripBom(raw))
  } catch {
    throw new Error('opencli list output is not valid JSON')
  }
  return parsed
}

/**
 * 读完 `opencli list -f json` 的全部条目,1.8.8(完整数组)与 2.0(分页外壳)都认。
 * @param {(extraArgs: string[]) => Promise<string>} fetchPage 追加参数后跑一次 list,返回 stdout 原文
 * @returns {Promise<{ envelope: boolean, list: object[], raw: string }>}
 */
export async function readListOutput(fetchPage) {
  const firstRaw = await fetchPage([])
  const first = parseListPage(firstRaw)
  if (Array.isArray(first)) return { envelope: false, list: first, raw: firstRaw }
  if (!first || first.ok !== true || !Array.isArray(first.data?.commands)) {
    throw new Error('opencli list output is not an array')
  }
  const list = [...first.data.commands]
  const raws = [firstRaw]
  let offset = 0
  let next = first.data.nextOffset
  while (next != null) {
    if (!Number.isInteger(next) || next <= offset) throw new Error('opencli list pagination did not advance')
    offset = next
    const raw = await fetchPage(['--limit', String(LIST_PAGE_LIMIT), '--offset', String(offset)])
    const page = parseListPage(raw)
    if (!page || page.ok !== true || !Array.isArray(page.data?.commands)) {
      throw new Error('opencli list output is not an array')
    }
    list.push(...page.data.commands)
    raws.push(raw)
    next = page.data.nextOffset
  }
  return { envelope: true, list, raw: raws.join('\n') }
}

/**
 * 2.0 的目录条目:以 manifest 为主体,只收 list 里出现过(能加载)的命令。
 * 参数按 1.8.8 的口径补齐默认值,审定哈希才与旧快照可比。
 */
export function buildCommandsFromManifest(list, manifest) {
  const manifestByKey = new Map(manifest.map((entry) => [`${entry.site} ${entry.name}`, entry]))
  const commands = []
  for (const listed of list) {
    const entry = manifestByKey.get(listed.command)
    if (!entry) continue
    commands.push({
      ...entry,
      command: `${entry.site}/${entry.name}`,
      aliases: entry.aliases ?? [],
      description: listed.description ?? entry.description,
      args: (entry.args ?? []).map((arg) => ({
        ...arg,
        choices: arg.choices ?? [],
        default: arg.default ?? null,
        valueRequired: arg.valueRequired ?? false,
        positional: arg.positional ?? false,
        required: arg.required ?? false,
      })),
    })
  }
  return commands
}

/** 把 readListOutput 的结果变成目录命令:1.8.8 走 list+manifest 补字段,2.0 走 manifest 构造。 */
export function commandsFromList({ envelope, list }, manifest) {
  return envelope ? buildCommandsFromManifest(list, manifest) : mergeManifestFields(list, manifest)
}
