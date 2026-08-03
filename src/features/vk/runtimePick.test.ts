import { missingCapabilityNote, pickBestRuntime, readyCount, runtimeToAdopt } from './runtimePick'
import type { VkRuntimeCandidate } from '../../host/vkClient'

const cap = (capability: string, runtime: 'ready' | string) => ({ capability, runtime, detail: null })

function candidate(over: Partial<VkRuntimeCandidate> = {}): VkRuntimeCandidate {
  return {
    pythonPath: 'C:\\x\\python.exe',
    source: 'app-owned',
    version: '0.1.0',
    apiVersion: '1.4.0',
    schemaVersion: '1.1.0',
    capabilities: [],
    compatible: true,
    reason: null,
    ...over,
  } as VkRuntimeCandidate
}

// 用户真实遇到的两个环境:同 api / 同 schema,只有 visual_evidence 有差别。
const appOwned = candidate({
  pythonPath: 'C:\\app\\python.exe', source: 'app-owned',
  capabilities: [
    cap('word_timestamps', 'missing_dependency'),
    cap('speaker_diarization', 'missing_dependency'),
    cap('visual_evidence', 'missing_dependency'),
    cap('search_document', 'ready'),
    cap('query_ready', 'ready'),
  ],
})
const devVenv = candidate({
  pythonPath: 'C:\\dev\\python.exe', source: 'developer-venv',
  capabilities: [
    cap('word_timestamps', 'missing_dependency'),
    cap('speaker_diarization', 'missing_dependency'),
    cap('visual_evidence', 'ready'),
    cap('search_document', 'ready'),
    cap('query_ready', 'ready'),
  ],
})

test('能力多的胜出 —— 这正是用户那两个环境的真实差别', () => {
  expect(readyCount(appOwned)).toBe(2)
  expect(readyCount(devVenv)).toBe(3)
  expect(pickBestRuntime([appOwned, devVenv])?.pythonPath).toBe('C:\\dev\\python.exe')
  expect(pickBestRuntime([devVenv, appOwned])?.pythonPath).toBe('C:\\dev\\python.exe')   // 与顺序无关
})

test('不兼容的一律不参选,哪怕它能力看起来最多', () => {
  const rich = candidate({
    pythonPath: 'C:\\bad\\python.exe', compatible: false, reason: 'schema 不匹配',
    capabilities: [cap('a', 'ready'), cap('b', 'ready'), cap('c', 'ready'), cap('d', 'ready')],
  })
  expect(pickBestRuntime([rich, appOwned])?.pythonPath).toBe('C:\\app\\python.exe')
  expect(pickBestRuntime([rich])).toBeNull()
})

test('一个候选都没有时返回 null —— 调用方保持现状,不乱换', () => {
  expect(pickBestRuntime([])).toBeNull()
  expect(runtimeToAdopt([])).toBeNull()
})

test('平局时留在当前环境 —— 否则两个等强的环境会在每次检测后来回翻', () => {
  const a = candidate({ pythonPath: 'A', source: 'developer-venv', capabilities: [cap('x', 'ready')] })
  const b = candidate({ pythonPath: 'B', source: 'other-venv', capabilities: [cap('x', 'ready')], active: true })

  expect(pickBestRuntime([a, b])?.pythonPath).toBe('B')
  expect(pickBestRuntime([b, a])?.pythonPath).toBe('B')
  expect(runtimeToAdopt([a, b])).toBeNull()      // 已在最强的那个上:一次 adopt 都不该发
})

test('平局且当前环境不在候选里时偏向 app-owned —— 那是爪爪能自己重建的那个', () => {
  const external = candidate({ pythonPath: 'E', source: 'developer-venv', capabilities: [cap('x', 'ready')] })
  const owned = candidate({ pythonPath: 'O', source: 'app-owned', capabilities: [cap('x', 'ready')] })

  expect(pickBestRuntime([external, owned])?.pythonPath).toBe('O')
  expect(pickBestRuntime([owned, external])?.pythonPath).toBe('O')
})

test('更强的那个不是当前环境时,才需要切换', () => {
  const weakActive = { ...appOwned, active: true }
  expect(runtimeToAdopt([weakActive, devVenv])?.pythonPath).toBe('C:\\dev\\python.exe')

  const strongActive = { ...devVenv, active: true }
  expect(runtimeToAdopt([appOwned, strongActive])).toBeNull()
})

test('能力缺失才有话说,全 ready 就闭嘴', () => {
  expect(missingCapabilityNote(devVenv)).toBe('暂不支持：逐词时间轴、说话人分离')
  expect(missingCapabilityNote(candidate({ capabilities: [cap('search_document', 'ready')] }))).toBeNull()
  expect(missingCapabilityNote(null)).toBeNull()
})
