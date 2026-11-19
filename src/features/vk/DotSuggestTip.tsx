import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { glassPopMotion, positionMenu } from '../../components/GlassMenu'
import './DotSuggestTip.css'

/** 小红书链接用什么解析:模型通道(付费)或点点速览(免费)。 */
export type XhsParser = 'model' | 'dot'

const OPEN_DELAY_MS = 400

type Placement = { top: number; left: number; above: boolean }

// 手绘云朵的三帧描边(云朵本体 + 两颗思考小圆泡),轮流显示就是手绘动画里的「线条抖动」。
// 画在 320×196 里,小圆泡在左上角,指向上方的链接框;贴士放在链接框上方时整幅上下翻转。
const CLOUD_FRAMES: ReadonlyArray<readonly [string, string, string]> = [
  [
    'M159.3 51.8 A38.9 38.9 0 0 1 233.1 61.0 A28.9 28.9 0 0 1 280.8 80.4 A20.3 20.3 0 0 1 304.4 108.0 A21.0 21.0 0 0 1 297.9 142.6 A24.9 24.9 0 0 1 260.1 165.1 A35.4 35.4 0 0 1 201.4 182.4 A44.2 44.2 0 0 1 123.2 180.2 A40.0 40.0 0 0 1 55.6 166.4 A23.8 23.8 0 0 1 21.9 140.6 A15.5 15.5 0 0 1 18.2 112.4 A24.2 24.2 0 0 1 42.8 81.2 A30.7 30.7 0 0 1 89.1 61.3 A42.2 42.2 0 0 1 159.3 51.8Z',
    'M64.4 34.0 A9.0 9.0 0 0 1 62.0 40.0 A9.0 9.0 0 0 1 56.0 42.9 A9.0 9.0 0 0 1 49.5 40.5 A9.0 9.0 0 0 1 47.5 34.0 A9.0 9.0 0 0 1 50.0 28.0 A9.0 9.0 0 0 1 56.0 25.3 A9.0 9.0 0 0 1 62.6 27.4 A9.0 9.0 0 0 1 64.4 34.0Z',
    'M45.4 14.0 A5.5 5.5 0 0 1 43.7 17.7 A5.5 5.5 0 0 1 40.0 19.2 A5.5 5.5 0 0 1 35.9 18.1 A5.5 5.5 0 0 1 34.4 14.0 A5.5 5.5 0 0 1 36.0 10.0 A5.5 5.5 0 0 1 40.0 8.5 A5.5 5.5 0 0 1 43.8 10.2 A5.5 5.5 0 0 1 45.4 14.0Z',
  ],
  [
    'M159.6 51.5 A39.5 39.5 0 0 1 228.7 61.2 A26.2 26.2 0 0 1 275.2 78.2 A26.7 26.7 0 0 1 306.8 108.4 A21.7 21.7 0 0 1 296.2 142.7 A24.8 24.8 0 0 1 257.0 168.1 A32.7 32.7 0 0 1 199.8 181.3 A37.6 37.6 0 0 1 129.2 183.9 A35.2 35.2 0 0 1 66.6 170.1 A28.4 28.4 0 0 1 24.5 144.3 A18.3 18.3 0 0 1 15.5 111.1 A25.4 25.4 0 0 1 45.7 79.7 A23.1 23.1 0 0 1 85.0 59.7 A40.2 40.2 0 0 1 159.6 51.5Z',
    'M64.5 34.0 A9.0 9.0 0 0 1 62.1 40.1 A9.0 9.0 0 0 1 56.0 42.8 A9.0 9.0 0 0 1 49.3 40.7 A9.0 9.0 0 0 1 47.0 34.0 A9.0 9.0 0 0 1 49.4 27.4 A9.0 9.0 0 0 1 56.0 25.5 A9.0 9.0 0 0 1 62.4 27.6 A9.0 9.0 0 0 1 64.5 34.0Z',
    'M45.6 14.0 A5.5 5.5 0 0 1 43.6 17.6 A5.5 5.5 0 0 1 40.0 19.3 A5.5 5.5 0 0 1 36.3 17.7 A5.5 5.5 0 0 1 34.3 14.0 A5.5 5.5 0 0 1 36.0 10.0 A5.5 5.5 0 0 1 40.0 8.2 A5.5 5.5 0 0 1 43.7 10.3 A5.5 5.5 0 0 1 45.6 14.0Z',
  ],
  [
    'M156.4 51.4 A41.0 41.0 0 0 1 231.5 59.1 A29.1 29.1 0 0 1 275.8 79.4 A21.9 21.9 0 0 1 302.2 107.9 A21.0 21.0 0 0 1 292.7 142.4 A25.6 25.6 0 0 1 255.0 166.8 A33.1 33.1 0 0 1 197.7 181.5 A42.9 42.9 0 0 1 120.1 181.9 A29.1 29.1 0 0 1 69.7 168.9 A29.1 29.1 0 0 1 22.8 144.1 A19.8 19.8 0 0 1 13.4 107.9 A24.1 24.1 0 0 1 41.1 78.3 A35.4 35.4 0 0 1 97.1 57.3 A36.3 36.3 0 0 1 156.4 51.4Z',
    'M65.1 34.0 A9.0 9.0 0 0 1 62.5 40.5 A9.0 9.0 0 0 1 56.0 43.4 A9.0 9.0 0 0 1 49.8 40.2 A9.0 9.0 0 0 1 46.8 34.0 A9.0 9.0 0 0 1 49.3 27.3 A9.0 9.0 0 0 1 56.0 24.5 A9.0 9.0 0 0 1 62.1 27.9 A9.0 9.0 0 0 1 65.1 34.0Z',
    'M45.1 14.0 A5.5 5.5 0 0 1 44.0 18.0 A5.5 5.5 0 0 1 40.0 19.2 A5.5 5.5 0 0 1 36.1 17.9 A5.5 5.5 0 0 1 34.4 14.0 A5.5 5.5 0 0 1 36.0 10.0 A5.5 5.5 0 0 1 40.0 8.5 A5.5 5.5 0 0 1 43.9 10.1 A5.5 5.5 0 0 1 45.1 14.0Z',
  ],
]

/**
 * 链接框里出现小红书链接时,从链接框冒出的手绘云朵贴士,问要不要用点点免费解析。
 * 弹出期间描边逐帧抖动、整体分步上下浮动;不加遮罩、不锁页面、不抢输入框的焦点。
 * 点「用模型」、按 Esc、点贴士和链接框以外的地方,都等于继续用模型。
 * 出现前先停顿片刻,粘贴或输入告一段落再弹。
 */
export function DotSuggestTip({ anchorRef, active, onChoose }: {
  anchorRef: RefObject<HTMLElement | null>
  /** 有小红书链接、且这批链接还没选过解析方式。 */
  active: boolean
  onChoose: (choice: XhsParser) => void
}) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) {
      setShown(false)
      return undefined
    }
    const timer = window.setTimeout(() => setShown(true), OPEN_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [active])

  const anchor = anchorRef.current
  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      {shown && anchor && <CloudBubble key="dot-tip" anchor={anchor} onChoose={onChoose} />}
    </AnimatePresence>,
    document.body,
  )
}

function CloudBubble({ anchor, onChoose }: { anchor: HTMLElement; onChoose: (choice: XhsParser) => void }) {
  const titleId = useId()
  const bodyId = useId()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const reduceMotion = useReducedMotion()

  useLayoutEffect(() => {
    const update = () => {
      const surface = surfaceRef.current
      if (!surface) return
      const { top, left } = positionMenu(anchor, surface)
      setPlacement({ top, left, above: top < anchor.getBoundingClientRect().top })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor])

  const chooseRef = useRef(onChoose)
  chooseRef.current = onChoose
  // 选定后贴士还要播一小段退场动画;这期间不能再把下一次点击(比如「开始解析」)当成「点在别处」
  const present = useIsPresent()
  useEffect(() => {
    if (!present) return undefined
    // 点在链接框里是继续编辑,不算忽略贴士
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && (surfaceRef.current?.contains(target) || anchor.contains(target))) return
      chooseRef.current('model')
    }
    // 外层面板可能自己用 Esc 关窗口,在捕获阶段先拦下,只关这张贴士
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      chooseRef.current('model')
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [anchor, present])

  return (
    <motion.div
      ref={surfaceRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="vk-dot-tip"
      data-placement={placement?.above ? 'above' : 'below'}
      className="dot-tip"
      style={placement
        ? { top: placement.top, left: placement.left, visibility: 'visible', originY: placement.above ? 1 : 0 }
        : { top: 0, left: 0, visibility: 'hidden' }}
      {...glassPopMotion(reduceMotion)}
    >
      <div className="dot-tip-float">
        <svg className="dot-tip-art" viewBox="0 0 320 196" width="320" height="196" aria-hidden="true">
          {CLOUD_FRAMES.map((frame, index) => (
            <g key={index} className={`dot-tip-frame dot-tip-frame-${index + 1}`}>
              {frame.map((d) => <path key={d} d={d} />)}
            </g>
          ))}
        </svg>
        <div className="dot-tip-content">
          <p id={titleId} className="dot-tip-title">用点点免费解析？</p>
          <p id={bodyId} className="dot-tip-body">约半分钟出总结 · 没有时间轴和行情图</p>
          <div className="dot-tip-actions">
            <button type="button" data-testid="vk-dot-tip-model" onClick={() => onChoose('model')}>用模型</button>
            <button type="button" data-testid="vk-dot-tip-dot" className="dot-tip-primary" onClick={() => onChoose('dot')}>用点点</button>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
