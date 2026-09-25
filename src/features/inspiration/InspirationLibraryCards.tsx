import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Trash2, X } from "lucide-react";
import { inspirationKindLabel, type InspirationFolder, type InspirationItem } from "./inspirationLibrary";

const papers = [
  { x: 40, idleY: -10, hoverY: -30, idleRotate: 10, hoverRotate: 14 },
  { x: 3, idleY: -20, hoverY: -35, idleRotate: 2, hoverRotate: -1 },
  { x: -40, idleY: -22, hoverY: -44, idleRotate: -5, hoverRotate: -9 },
];
const FLAP_PATH = "M0 25C0 11.1929 11.1929 0 25 0H136.084C143.044 0 149.689 2.90139 154.42 8.00608L178.08 33.5343C182.811 38.639 189.456 41.5404 196.416 41.5404H296C309.807 41.5404 321 52.7333 321 66.5404V216C321 229.807 309.807 241 296 241H25C11.1929 241 0 229.807 0 216V25Z";

function useLiveReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function FolderPaper({ filterId }: { filterId: string }) {
  return <svg viewBox="0 0 164 214" aria-hidden="true">
    <defs><filter id={filterId} x="-8%" y="-8%" width="120%" height="125%"><feDropShadow dx="3" dy="5" stdDeviation="3" floodOpacity="0.25" /></filter></defs>
    <rect width="163" height="213" rx="20" fill="#f1f1f1" stroke="#e0e0e0" filter={`url(#${filterId})`} />
    <rect x="14" y="31" width="135" height="12" rx="6" fill="#d4d4d4" />
    {Array.from({ length: 9 }, (_, row) => [14, 84].map((x, column) =>
      <rect key={`${row}-${column}`} x={x} y={61 + row * 14} width="65" height="6" rx="3" fill="#d4d4d4" />))}
  </svg>;
}

export function InspirationFolderCard({
  folder,
  count,
  paperCount,
  onOpen,
}: {
  folder: InspirationFolder;
  count: number;
  paperCount: number;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const reduceMotion = useLiveReducedMotion();
  const filterId = `folder-shadow-${useId().replace(/:/g, "")}`;
  return (
    <button
      type="button"
      data-testid={`inspiration-folder-item-${folder.id}`}
      className="inspiration-folder-card"
      onPointerEnter={() => setExpanded(true)}
      onPointerLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={() => setExpanded(false)}
      onClick={onOpen}
    >
      <span className="inspiration-folder-art" aria-hidden="true">
        <span className="inspiration-folder-stage">
          <span className="inspiration-folder-back" />
          {papers
            .filter((_, index) => paperCount >= 3 || (paperCount === 2 && index !== 1) || (paperCount === 1 && index === 1))
            .map((paper, index) => (
              <motion.span
                key={index}
                className="inspiration-folder-paper"
                animate={{
                  x: paperCount === 1 ? 0 : paper.x,
                  y: reduceMotion ? paper.idleY : expanded ? paper.hoverY : paper.idleY,
                  rotate: reduceMotion ? 0 : expanded ? paper.hoverRotate : paper.idleRotate,
                }}
                initial={false}
                transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 13 }}
              >
                <FolderPaper filterId={`${filterId}-paper-${index}`} />
              </motion.span>
            ))}
          <motion.span
            className="inspiration-folder-front"
            initial={false}
            animate={{ rotateX: reduceMotion ? 0 : expanded ? -45 : -15 }}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 14 }}
          >
            <span className="inspiration-folder-front-blur" />
            <svg viewBox="0 0 321 241">
              <defs>
                <filter id={filterId} x="-20%" y="-20%" width="140%" height="150%">
                  <feDropShadow dx="0" dy="7" stdDeviation="8" floodOpacity="0.36" />
                </filter>
              </defs>
              <path filter={`url(#${filterId})`} d={FLAP_PATH} fill="#292929" fillOpacity="0.25" stroke="#979797" />
            </svg>
          </motion.span>
        </span>
      </span>
      <span className="inspiration-library-card-meta">
        <strong>{folder.name}</strong>
        <small>文件夹 · {count} 项</small>
      </span>
    </button>
  );
}

export function InspirationFileCard({
  item,
  selected,
  formattedDate,
  onOpen,
  onDelete,
}: {
  item: InspirationItem;
  selected: boolean;
  formattedDate: string;
  onOpen: () => void;
  onDelete: () => boolean;
}) {
  const filterId = `file-shadow-${useId().replace(/:/g, "")}`;
  const [confirming, setConfirming] = useState(false);
  const reduceMotion = useLiveReducedMotion();
  useEffect(() => {
    if (!confirming) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirming(false);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [confirming]);
  return (
    <div className={`inspiration-file-card${selected ? " is-selected" : ""}`}>
      <button
        type="button"
        data-testid={`inspiration-item-${item.id}`}
        className="inspiration-file-card-open"
        onClick={onOpen}
      >
        <span className="inspiration-file-paper" aria-hidden="true">
          <FolderPaper filterId={filterId} />
        </span>
        <span className="inspiration-library-card-meta">
          <strong>{item.title || "未命名灵感"}</strong>
          <small>{inspirationKindLabel(item.kind)} · {formattedDate}</small>
        </span>
      </button>
      <div className="inspiration-file-delete">
        <AnimatePresence mode="wait" initial={false}>
          {confirming ? (
            <motion.div
              key="confirm"
              className="inspiration-file-delete-confirm"
              initial={reduceMotion ? false : { opacity: 0.96, width: 26, x: 2 }}
              animate={{ opacity: 1, width: 56, x: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0.96, width: 26, x: 2 }}
              transition={{ duration: reduceMotion ? 0 : 0.12 }}
            >
              <button type="button" className="is-confirm" aria-label={`确认删除 ${item.title || "未命名灵感"}`} title="确认删除" onClick={() => { if (onDelete()) setConfirming(false); }}><Check size={13} aria-hidden="true" /></button>
              <button type="button" aria-label="取消删除" title="取消" onClick={() => setConfirming(false)}><X size={13} aria-hidden="true" /></button>
            </motion.div>
          ) : (
            <motion.button
              key="delete"
              type="button"
              aria-label={`删除笔记 ${item.title || "未命名灵感"}`}
              title="删除笔记"
              onClick={() => setConfirming(true)}
              initial={false}
              exit={reduceMotion ? undefined : { opacity: 0.96 }}
              transition={{ duration: reduceMotion ? 0 : 0.12 }}
            ><span className="inspiration-file-delete-trash" aria-hidden="true"><Trash2 size={14} /></span></motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
