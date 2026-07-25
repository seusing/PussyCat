// appendOutput 基准:对比「legacy(优化前:每事件 some+sort)」与「current-fastpath(当前实现:
// 单调时不可变追加,免 some/sort)」。**命名要点(评审 P3)**:legacy 是被替换掉的旧实现,
// current-fastpath 才是仓内当前代码——早期版本把旧实现叫 current,输出表读起来像
// 「当前代码慢 13 倍」,正好读反。
// 用法:node scripts/bench-append-output.mjs [N...]   例:node scripts/bench-append-output.mjs 2000 10000
// 口径:两者渐近同为 O(n²)(不可变复制),快路径只剔除 some/sort 常数——见 docs/specs/2026-07-25-p0-c-c-robustness-design.md §4
// ⚠️ 本脚本是 src/store/appStore.ts `appendOutput` 的**手抄副本**,不 import 真实 reducer
// (它耦合 store/状态机)。改动 appendOutput 时请同步本文件,否则基准会静默漂移(评审 M-3)。
function bench(N, impl) {
  let lines = []
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < N; i++) {
    const e = { seq: i, text: 'line-' + i }
    if (impl === 'legacy') {
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
console.log('N\tlegacy(ms)\tcurrent-fastpath(ms)\tspeedup')
for (const N of targets) {
  const legacy = bench(N, 'legacy')
  const current = bench(N, 'current-fastpath')
  console.log(`${N}\t${legacy.toFixed(0)}\t${current.toFixed(0)}\t${(legacy / current).toFixed(1)}x`)
}
