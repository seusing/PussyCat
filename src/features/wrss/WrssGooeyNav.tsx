import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion, useSpring, useTransform } from "motion/react";
import type { WrssView } from "./wrssClient";

const items = [["latest", "最新文章"], ["favorites", "我的收藏"], ["sources", "已订阅公众号"]] as const;
const SPRING = { type: "spring", stiffness: 200, damping: 28, mass: 1 } as const;
const SPAN = 16, NECK_HEIGHT = 100, NECK_BREAK = 0.22;

function neckPath(gap: number) {
  if (!Number.isFinite(gap) || gap <= 0) return "";
  const waist = NECK_HEIGHT * (1 - gap / (SPAN * NECK_BREAK));
  if (waist <= 0) return "";
  const start = SPAN - gap, middle = start + gap / 2;
  return `M${start} 0 Q${middle} ${NECK_HEIGHT - waist} ${SPAN} 0 L${SPAN} ${NECK_HEIGHT} Q${middle} ${waist} ${start} ${NECK_HEIGHT} Z`;
}

function Segment({ gap, seam, active, leftActive, openLeft, openRight, reduced, children }: { gap: number; seam: boolean; active: boolean; leftActive: boolean; openLeft: boolean; openRight: boolean; reduced: boolean; children: ReactNode }) {
  const marginLeft = useSpring(gap, SPRING);
  const gradientId = `wrss-gooey-neck-${useId().replace(/:/g, "")}`;
  useEffect(() => { if (reduced) marginLeft.jump(gap); else marginLeft.set(gap); }, [gap, marginLeft, reduced]);
  const d = useTransform(marginLeft, neckPath);
  return (
    <motion.li className={active ? "is-active" : ""} style={{ marginLeft }} initial={false}
      animate={{ borderTopLeftRadius: openLeft ? 10 : 0, borderBottomLeftRadius: openLeft ? 10 : 0, borderTopRightRadius: openRight ? 10 : 0, borderBottomRightRadius: openRight ? 10 : 0 }} transition={reduced ? { duration: 0 } : SPRING}>
      {seam && <svg aria-hidden="true" className="wrss-gooey-neck" width={SPAN} viewBox={`0 0 ${SPAN} ${NECK_HEIGHT}`} preserveAspectRatio="none">
        <defs><linearGradient id={gradientId} x1="0" x2="1"><stop offset="0" stopColor={leftActive ? "#263d70" : "#171c27"} /><stop offset="1" stopColor={active ? "#263d70" : "#171c27"} /></linearGradient></defs>
        <motion.path d={d} fill={`url(#${gradientId})`} />
      </svg>}
      {children}
    </motion.li>
  );
}

export default function WrssGooeyNav({ view, onChange, reduced = false }: { view: WrssView; onChange: (view: "latest" | "favorites" | "sources") => void; reduced?: boolean }) {
  const navRef = useRef<HTMLElement>(null);
  const [rows, setRows] = useState<number[][]>([[0, 1, 2]]);
  const [naturalWidth, setNaturalWidth] = useState<number>();
  const selected = view.startsWith("account:") ? "sources" : view;
  const active = items.findIndex(([value]) => value === selected);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const widths = items.map((_, index) =>
        (nav.querySelector(`[data-nav-index="${index}"]`) as HTMLElement | null)?.offsetWidth ?? 0,
      );
      const natural = widths.reduce((sum, width) => sum + width, 0) + SPAN * (items.length - 1);
      if (natural > 0) setNaturalWidth((current) => current === natural ? current : natural);
      const parentWidth = nav.parentElement?.clientWidth || nav.clientWidth || natural;
      const available = Math.min(parentWidth, natural);
      const next: number[][] = [];
      let row: number[] = [], used = 0;
      widths.forEach((width, index) => {
        const needed = width + (row.length ? SPAN : 0);
        if (row.length && used + needed > available) {
          next.push(row);
          row = [];
          used = 0;
        }
        row.push(index);
        used += width + (row.length > 1 ? SPAN : 0);
      });
      if (row.length) next.push(row);
      setRows((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);
  return <nav ref={navRef} className="wrss-gooey-nav" aria-label="公众号内容入口" style={{ width: naturalWidth }}>
    {rows.map((row) => <ul key={row.join("-")}>
      {row.map((index, position) => {
        const [value, label] = items[index];
        const openLeft = position === 0 || index - 1 === active || index === active;
        const openRight = position === row.length - 1 || index === active || index + 1 === active;
        return <Segment key={value} gap={position === 0 ? 0 : openLeft ? SPAN : -1} seam={position > 0} active={index === active} leftActive={index - 1 === active} openLeft={openLeft} openRight={openRight} reduced={reduced}>
          <button data-nav-index={index} type="button" aria-pressed={index === active} onClick={() => onChange(value)}>{label}</button>
        </Segment>;
      })}
    </ul>)}
  </nav>;
}
