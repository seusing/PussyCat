import { render } from '@testing-library/react'
import App from '../App'
import type { CatalogSource } from '../host'
import type { HostBridge, RunRequest } from '../host/types'
import type { CommandManifest, CatalogSnapshot } from '../data/types'
import type { PolicyDecision } from '../data/policy'

// 测试辅助:渲染已连接态(mode="connected")的 App,注入
//   ① 一个记录 startCommand 调用的 spy host,
//   ② 一个把给定 commands/decisions 直接打包成 {snapshot, decisions} 的 catalogSource,
// 用于证明前端只读 Host 判决、不自行裁决(I-P1)——对抗 fixture(App.test.tsx)据此构造。
export function renderWithHost({
  commands,
  decisions,
  onStart,
}: {
  commands: CommandManifest[]
  decisions: PolicyDecision[]
  onStart?: (req: RunRequest) => void
}) {
  const startCommand = vi.fn((req: RunRequest) => {
    onStart?.(req)
    return Promise.resolve({ runId: req.runId })
  })
  const host: HostBridge = {
    startCommand,
    cancelCommand: async () => {},
    onOutput: () => () => {},
    onDone: () => () => {},
  }
  const snapshot: CatalogSnapshot = {
    schemaVersion: 1,
    generatedAt: Date.now(),
    opencliVersion: 'test',
    source: 'test-fixture',
    listSha256: 'test',
    manifestSha256: 'test',
    commands,
  }
  const catalogSource: CatalogSource = {
    kind: 'live',
    load: async () => ({ snapshot, decisions }),
  }
  return render(<App host={host} catalogSource={catalogSource} mode="connected" />)
}
