import { type CSSProperties, type PointerEvent, type ReactNode, useCallback } from 'react'
import './BorderGlow.css'

type BorderGlowProps = {
  children: ReactNode
  className?: string
  testId?: string
  radius?: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function angleForNearestEdge(x: number, y: number, width: number, height: number) {
  const distances = [
    { value: y, angle: -90 },
    { value: width - x, angle: 0 },
    { value: height - y, angle: 90 },
    { value: x, angle: 180 },
  ]
  return distances.reduce((nearest, edge) => edge.value < nearest.value ? edge : nearest).angle
}

export function BorderGlow({ children, className = '', testId, radius = 96 }: BorderGlowProps) {
  const updateGlow = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const x = clamp(event.clientX - rect.left, 0, rect.width)
    const y = clamp(event.clientY - rect.top, 0, rect.height)
    const edgeDistance = Math.min(x, y, rect.width - x, rect.height - y)
    const edgeProximity = clamp(1 - edgeDistance / radius, 0, 1)
    const intensity = clamp(0.2 + edgeProximity * 0.8, 0, 1)

    element.style.setProperty('--border-glow-x', `${(x / rect.width) * 100}%`)
    element.style.setProperty('--border-glow-y', `${(y / rect.height) * 100}%`)
    element.style.setProperty('--border-glow-edge', edgeProximity.toFixed(3))
    element.style.setProperty('--border-glow-intensity', intensity.toFixed(3))
    element.style.setProperty('--border-glow-angle', `${angleForNearestEdge(x, y, rect.width, rect.height)}deg`)
  }, [radius])

  const clearGlow = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.style.setProperty('--border-glow-intensity', '0')
    event.currentTarget.style.setProperty('--border-glow-edge', '0')
  }, [])

  return (
    <div
      className={`border-glow ${className}`.trim()}
      data-testid={testId}
      onPointerMove={updateGlow}
      onPointerLeave={clearGlow}
      style={{ '--border-glow-radius': `${radius}px` } as CSSProperties}
    >
      <div className="border-glow-content">{children}</div>
    </div>
  )
}
