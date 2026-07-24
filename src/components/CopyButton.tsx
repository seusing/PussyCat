import { useEffect, useRef, useState } from 'react'
import { copyText } from '../lib/clipboard'

export function CopyButton({ label, getText, testid }: { label: string; getText: () => string; testid: string }) {
  const [flash, setFlash] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const onClick = async () => {
    const ok = await copyText(getText())
    setFlash(ok ? 'ok' : 'fail')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setFlash('idle'), 1500)
  }
  return (
    <button data-testid={testid} onClick={onClick}
      className="rounded-lg px-2 py-1 text-xs"
      style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}>
      {flash === 'ok' ? '已复制' : flash === 'fail' ? '复制失败' : label}
    </button>
  )
}
