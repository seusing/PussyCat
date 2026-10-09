import { describe, expect, test, vi } from 'vitest'
import {
  findDefaultContextId,
  listBrowserProfiles,
  parseProfileList,
  useBrowserProfile,
} from './browser-bridge-profiles.mjs'

// `opencli profile list` 的真实输出形状(node_modules/@jackwener/opencli/dist/src/cli.js:3071-3095)。
const LIST = [
  'Connected Browser Bridge profiles',
  '',
  '  ctx-aaa work default — connected v0.9.1',
  '  ctx-bbb — connected version unknown',
  '  ctx-ccc home — connected v0.9.0',
  '',
  'Disconnected saved profiles:',
  '  ctx-old gone — not connected',
  '  ctx-stale — default, not connected',
].join('\n')

const ok = (stdout) => vi.fn(async () => ({ code: 0, failed: false, stdout }))

describe('profile list 解析', () => {
  test('已连接的 profile:别名、默认标记、扩展版本都取出来', () => {
    expect(parseProfileList(LIST)).toEqual([
      { contextId: 'ctx-aaa', alias: 'work', isDefault: true, extensionVersion: '0.9.1' },
      { contextId: 'ctx-bbb', isDefault: false },
      { contextId: 'ctx-ccc', alias: 'home', isDefault: false, extensionVersion: '0.9.0' },
    ])
  })

  test('没起别名但是默认的那个:default 是标记,不是别名', () => {
    expect(parseProfileList('  ctx-1 default — connected v1.0.0')).toEqual([
      { contextId: 'ctx-1', isDefault: true, extensionVersion: '1.0.0' },
    ])
  })

  test('「未连接」的保存项不算可选 profile', () => {
    expect(parseProfileList('Disconnected saved profiles:\n  ctx-old gone — not connected')).toEqual([])
  })

  test('daemon 没跑 / 没有 profile / 版本过期时的提示文字解析成空清单', () => {
    expect(parseProfileList('Daemon is not running. Run opencli doctor after opening Chrome.')).toEqual([])
    expect(parseProfileList('No Browser Bridge profiles connected.')).toEqual([])
    expect(parseProfileList('Daemon v1.0.0 is stale for CLI v1.8.6.\nRun: opencli daemon restart')).toEqual([])
    expect(parseProfileList(undefined)).toEqual([])
  })

  test('Windows 换行', () => {
    expect(parseProfileList('Connected Browser Bridge profiles\r\n\r\n  ctx-1 work — connected v0.9.1\r\n'))
      .toEqual([{ contextId: 'ctx-1', alias: 'work', isDefault: false, extensionVersion: '0.9.1' }])
  })
})

describe('列出与选择', () => {
  test('清单给前端的是 name(别名优先,否则 contextId),跑的是 profile list', async () => {
    const runOpenCli = ok(LIST)
    const result = await listBrowserProfiles({ runOpenCli, opencliEntry: '/entry.js' })

    expect(runOpenCli).toHaveBeenCalledWith(['profile', 'list'], expect.objectContaining({ opencliEntry: '/entry.js' }))
    expect(result).toEqual({
      ok: true,
      profiles: [
        { name: 'work', isDefault: true, extensionVersion: '0.9.1' },
        { name: 'ctx-bbb', isDefault: false },
        { name: 'home', isDefault: false, extensionVersion: '0.9.0' },
      ],
    })
  })

  test('子进程没跑成:如实 ok:false,不返回空清单冒充"没有 profile"', async () => {
    const runOpenCli = vi.fn(async () => ({ code: null, failed: true, detail: 'timeout' }))
    await expect(listBrowserProfiles({ runOpenCli, opencliEntry: '/entry.js' }))
      .resolves.toEqual({ ok: false, reasonCode: 'profile-list-failed' })
  })

  test('选清单里的别名:执行 profile use <别名>', async () => {
    const runOpenCli = vi.fn(async (argv) => (argv[1] === 'list'
      ? { code: 0, failed: false, stdout: LIST }
      : { code: 0, failed: false }))
    const result = await useBrowserProfile({ name: 'home', runOpenCli, opencliEntry: '/entry.js' })

    expect(result).toEqual({ ok: true })
    expect(runOpenCli).toHaveBeenLastCalledWith(['profile', 'use', 'home'], expect.any(Object))
  })

  test('没起别名的 profile 用 contextId 选', async () => {
    const runOpenCli = vi.fn(async (argv) => (argv[1] === 'list'
      ? { code: 0, failed: false, stdout: LIST }
      : { code: 0, failed: false }))
    await expect(useBrowserProfile({ name: 'ctx-bbb', runOpenCli, opencliEntry: '/entry.js' })).resolves.toEqual({ ok: true })
    expect(runOpenCli).toHaveBeenLastCalledWith(['profile', 'use', 'ctx-bbb'], expect.any(Object))
  })

  test('不在清单里的名字不交给子进程', async () => {
    const runOpenCli = ok(LIST)
    const result = await useBrowserProfile({ name: '--help', runOpenCli, opencliEntry: '/entry.js' })

    expect(result).toEqual({ ok: false, reasonCode: 'profile-not-listed' })
    expect(runOpenCli).toHaveBeenCalledTimes(1)          // 只有那次 list
    expect(runOpenCli).not.toHaveBeenCalledWith(expect.arrayContaining(['use']), expect.anything())
  })

  test('profile use 退出码非 0:报 profile-use-failed', async () => {
    const runOpenCli = vi.fn(async (argv) => (argv[1] === 'list'
      ? { code: 0, failed: false, stdout: LIST }
      : { code: 2, failed: true }))
    await expect(useBrowserProfile({ name: 'work', runOpenCli, opencliEntry: '/entry.js' }))
      .resolves.toEqual({ ok: false, reasonCode: 'profile-use-failed' })
  })

  test('默认 profile 的 contextId:取带 default 标记且已连接的那一项', async () => {
    await expect(findDefaultContextId({ runOpenCli: ok(LIST), opencliEntry: '/entry.js' })).resolves.toBe('ctx-aaa')
    await expect(findDefaultContextId({ runOpenCli: ok('  ctx-1 — connected v1'), opencliEntry: '/entry.js' })).resolves.toBeUndefined()
    await expect(findDefaultContextId({
      runOpenCli: vi.fn(async () => ({ code: 1, failed: true })), opencliEntry: '/entry.js',
    })).resolves.toBeUndefined()
  })
})
