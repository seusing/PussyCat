import { useEffect, useState } from 'react'
import type { DotTurn } from './dotHistory'

// 3×3 像素格,一道 V 形波从左往右推;周期比一趟扫过短,所以总有两道波在走
const WAVE_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3)
  const column = index % 3
  return (column + Math.abs(row - 1)) * 90
})

function PixelGrid() {
  return (
    <span className="dot-pixels" aria-hidden="true">
      {WAVE_DELAYS.map((delay, index) => <span key={index} style={{ animationDelay: `${delay}ms` }} />)}
    </span>
  )
}

/** 12.3s;满一分钟写成 1m 4.0s。 */
export function formatSeconds(ms: number): string {
  const total = Math.max(0, ms) / 1000
  if (total < 60) return `${total.toFixed(1)}s`
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`
}

function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [running])
  return now
}

/**
 * 点点的思考过程。还没出正文时是像素格 + 闪光的当前步骤 + 计时;
 * 正文开始后收成一行「思考 4.1s」,点开看全部步骤。
 */
export function DotThinking({ turn }: { turn: DotTurn }) {
  const live = turn.state === 'waiting' || turn.state === 'streaming'
  const thinking = live && !turn.answer
  const now = useNow(thinking)

  if (thinking) {
    const label = turn.steps[turn.steps.length - 1] ?? '点点正在想'
    return (
      <div className="dot-thinking" role="status" data-testid="dot-thinking">
        <PixelGrid />
        <span className="dot-shimmer">{label}</span>
        {turn.startedAt > 0 && <span className="dot-elapsed">{formatSeconds(now - turn.startedAt)}</span>}
      </div>
    )
  }

  const end = turn.answeredAt ?? turn.finishedAt
  const parts = [
    turn.startedAt > 0 && end ? `思考 ${formatSeconds(end - turn.startedAt)}` : '',
    live ? '' : turn.sourceTotal,
  ].filter(Boolean)
  if (parts.length === 0 && turn.steps.length === 0) return null
  return (
    <details className="dot-steps" data-testid="dot-steps">
      <summary>{parts.join(' · ') || `思考过程 · ${turn.steps.length} 步`}</summary>
      {turn.steps.length > 0 && (
        <ol>
          {turn.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      )}
    </details>
  )
}
