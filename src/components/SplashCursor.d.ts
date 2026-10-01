import type { ComponentType } from 'react'

export type SplashEmitter = {
  x: number
  y: number
  radius: number
  force: { x: number; y: number }
  color: { r: number; g: number; b: number }
  sway?: number
  swayPeriod?: number
  pulse?: number
  pulsePeriod?: number
  phase?: number
  jitter?: number
}

declare const SplashCursor: ComponentType<{
  RAINBOW_MODE?: boolean
  COLOR?: string
  SPLAT_FORCE?: number
  CURL?: number
  DENSITY_DISSIPATION?: number
  VELOCITY_DISSIPATION?: number
  EMITTERS?: SplashEmitter[]
  EMIT_WARMUP?: number
}>

export default SplashCursor
