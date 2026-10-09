// 多 Chrome profile 的选择 —— 「列出已连接的 profile」与「选一个当默认」。
//
// 数据源是 opencli 自带的 `profile list` / `profile use <别名>` 子命令(dist/src/cli.js:3049-3120):
//   · `profile use <profile>` 接受别名或 contextId,把它写成默认 profile,成功退出码 0;
//   · `profile list` **没有 JSON 输出**(没有 -f 选项),只有人读的文本。已连接的 profile 每行:
//       `  <contextId>[ <别名>][ default] — connected[ v<扩展版本>| version unknown]`
//     所以这里只解析"已连接"这一种行,别的输出(daemon 没跑、没有 profile 等)一律解析成空清单。
//
// 对前端暴露的 `name` 是别名,没起过别名的退回 contextId —— 两者 `profile use` 都认。
// 前端只能从当前清单里选:提交的名字不在清单里,不会交给子进程。

import { PROFILE_USE_TIMEOUT_MS } from './browser-bridge-repair.mjs'

const CONNECTED_LINE = /^\s+(\S+)(.*?) — connected(?: v(\S+)| version unknown)\s*$/

/** 把 `profile list` 的 stdout 解析成已连接 profile 清单。 */
export function parseProfileList(stdout) {
  const profiles = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = CONNECTED_LINE.exec(line)
    if (!match) continue
    const [, contextId, rest, extensionVersion] = match
    let alias = rest.trim()
    let isDefault = false
    if (alias === 'default') {
      alias = ''
      isDefault = true
    } else if (alias.endsWith(' default')) {
      alias = alias.slice(0, -' default'.length).trim()
      isDefault = true
    }
    profiles.push({
      contextId,
      ...(alias ? { alias } : {}),
      isDefault,
      ...(extensionVersion ? { extensionVersion } : {}),
    })
  }
  return profiles
}

async function readConnectedProfiles({ runOpenCli, opencliEntry }) {
  const result = await runOpenCli(['profile', 'list'], { opencliEntry, timeoutMs: PROFILE_USE_TIMEOUT_MS })
  return result.failed ? undefined : parseProfileList(result.stdout)
}

/** 列出已连接的 profile。失败(子进程没跑成)如实返回 ok:false,不伪造空清单。 */
export async function listBrowserProfiles({ runOpenCli, opencliEntry }) {
  const profiles = await readConnectedProfiles({ runOpenCli, opencliEntry })
  if (!profiles) return { ok: false, reasonCode: 'profile-list-failed' }
  return {
    ok: true,
    profiles: profiles.map((profile) => ({
      name: profile.alias ?? profile.contextId,
      isDefault: profile.isDefault,
      ...(profile.extensionVersion ? { extensionVersion: profile.extensionVersion } : {}),
    })),
  }
}

/** 默认 profile 的 contextId;没设过、或设过但当前没连着,都是 undefined。 */
export async function findDefaultContextId({ runOpenCli, opencliEntry }) {
  const profiles = await readConnectedProfiles({ runOpenCli, opencliEntry })
  return profiles?.find((profile) => profile.isDefault)?.contextId
}

/** 选定默认 profile。`name` 必须是当前清单里的某一项。 */
export async function useBrowserProfile({ name, runOpenCli, opencliEntry }) {
  const listed = await listBrowserProfiles({ runOpenCli, opencliEntry })
  if (!listed.ok) return listed
  if (!listed.profiles.some((profile) => profile.name === name)) {
    return { ok: false, reasonCode: 'profile-not-listed' }
  }
  const result = await runOpenCli(['profile', 'use', name], { opencliEntry, timeoutMs: PROFILE_USE_TIMEOUT_MS })
  return result.failed ? { ok: false, reasonCode: 'profile-use-failed' } : { ok: true }
}
