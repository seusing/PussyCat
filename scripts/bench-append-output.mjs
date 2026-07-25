// appendOutput 快路径基准:对比「现实现(每事件 some+sort)」与「快路径(单调时不可变追加,免 some/sort)」。
// 用法:node scripts/bench-append-output.mjs [N...]   例:node scripts/bench-append-output.mjs 2000 10000
// 口径:两者渐近同为 O(n²)(不可变复制),快路径只剔除 some/sort 常数——见 docs/specs/2026-07-25-p0-c-c-robustness-design.md §4
// ⚠️ 本脚本是 src/store/appStore.ts `appendOutput`(快路径分支)的**手抄副本**,不 import 真实 reducer
// (它耦合 store/状态机)。改动 appendOutput 时请同步本文件,否则基准会静默漂移(评审 M-3)。
function bench(N, impl) {
  let lines = []
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < N; i++) {
    const e = { seq: i, text: 'line-' + i }
    if (impl === 'current') {
      if (lines.some((l) => l.seq === e.seq)) continue
      lines = [...lines, e].sort((a, b) => a.seq - b.seq)
    } else {
      const last = lines[lines.length - 1]
      if (!last || e.seq > last.seq) lines = [...lines, e]
      else if (!lines.some((l) => l.seq === e.seq)) lines = [...lines, e].sort((a, b) => a.seq - b.seq)
    }
  }
  return Number(process.hrtime.bigint() - t0) / 1e6
}

const sizes = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0)
const targets = sizes.length ? sizes : [2000, 5000, 10000, 20000, 50000]
console.log('N\tcurrent(ms)\tfastpath(ms)\tratio')
for (const N of targets) {
  const c = bench(N, 'current')
  const f = bench(N, 'fast')
  console.log(`${N}\t${c.toFixed(0)}\t${f.toFixed(0)}\t${(c / f).toFixed(1)}x`)
}
