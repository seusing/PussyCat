import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide'
import { copyText } from '../lib/clipboard'
import { IconActionButton } from './IconActionButton'

export function CopyButton({ label, getText, testid, className }: {
  label: string
  getText: () => string
  testid: string
  className?: string
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
    <IconActionButton
      icon={flash === 'ok' ? Check : Copy}
      label={currentLabel}
      data-testid={testid}
      data-state={flash}
      className={className}
      onClick={onClick}
    />
  )
}
