import type { SVGProps } from 'react'

/** 导航栏里的点点:圆脸加两只眼睛,线条风格与 lucide 图标一致。 */
export function DotNavIcon({ size = 24, strokeWidth = 2, ...props }: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} {...props}>
      <circle cx="12" cy="12.5" r="8.5" />
      <ellipse cx="9.4" cy="11.6" rx="1.15" ry="1.9" fill="currentColor" stroke="none" transform="rotate(-14 9.4 11.6)" />
      <ellipse cx="14.6" cy="11.6" rx="1.15" ry="1.9" fill="currentColor" stroke="none" transform="rotate(-14 14.6 11.6)" />
    </svg>
  )
}
