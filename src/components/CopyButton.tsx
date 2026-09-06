import { useEffect, useRef, useState } from 'react'
import { copyText } from '../lib/clipboard'
import { MicroButton } from './MicroButton'

export function CopyButton({ label, getText, testid, iconOnly = false }: {
  label: string
  getText: () => string
  testid: string
  iconOnly?: boolean
}) {
  const [flash, setFlash] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const onClick = async () => {
    const ok = await copyText(getText())
    setFlash(ok ? 'ok' : 'fail')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setFlash('idle'), 1500)
  }
  const currentLabel = flash === 'ok' ? '已复制' : flash === 'fail' ? '复制失败' : label

  return (
    <MicroButton
      variant="copy"
      active={flash === 'ok'}
      data-testid={testid}
      onClick={onClick}
      aria-label={iconOnly ? currentLabel : undefined}
      title={iconOnly ? currentLabel : undefined}
      style={iconOnly ? { width: 36, padding: 0 } : undefined}
    >
      {iconOnly ? <span className="sr-only">{currentLabel}</span> : currentLabel}
    </MicroButton>
  )
}
