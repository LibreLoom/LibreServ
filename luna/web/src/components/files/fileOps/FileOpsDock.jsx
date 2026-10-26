import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import SlideCollapse, { SLIDE_COLLAPSE_MS } from "@libreloom/ui/components/common/SlideCollapse.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { useFileOps, useFileOpsState } from "../../../context/FileOpsContext.jsx";
import { labels } from "../../../lib/fileOps/copy.js";
import { dockInfo, visibleOps } from "../../../lib/fileOps/selectors.js";
import FileOpRow from "./FileOpRow.jsx";

/** Desktop opens expanded, phones start collapsed. */
function startsExpanded() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(min-width: 1280px)").matches;
}

/**
 * Rows that just left the store stay for one exit animation, so they slide away.
 * @param {import("../../../lib/fileOps/store.js").Op[]} ops
 */
function useLeavingRows(ops) {
  const seen = useRef(/** @type {Map<string, import("../../../lib/fileOps/store.js").Op>} */ (new Map()));
  const [leaving, setLeaving] = useState(/** @type {import("../../../lib/fileOps/store.js").Op[]} */ ([]));

  useEffect(() => {
    const now = new Set(ops.map((o) => o.id));
    const gone = [...seen.current.values()].filter((o) => !now.has(o.id));
    seen.current = new Map(ops.map((o) => [o.id, o]));
    if (!gone.length) return undefined;
    setLeaving((list) => [...list, ...gone.filter((g) => !list.some((l) => l.id === g.id))]);
    const timer = setTimeout(
      () => setLeaving((list) => list.filter((l) => !gone.some((g) => g.id === l.id))),
      SLIDE_COLLAPSE_MS + 50,
    );
    return () => clearTimeout(timer);
  }, [ops]);

  return leaving.filter((l) => !ops.some((o) => o.id === l.id));
}

/**
 * The file task card: every running or troubled file operation of this tab,
 * above the navbar on every in-app page. Renders nothing when there is none.
 */
export default function FileOpsDock() {
  const store = useFileOps();
  const ops = useFileOpsState(visibleOps);
  const info = useFileOpsState(dockInfo);
  const leaving = useLeavingRows(ops);
  const [expanded, setExpanded] = useState(startsExpanded);
  const lastProblems = useRef(0);

  // Open by itself when a new problem shows up.
  useEffect(() => {
    if (info.problemCount > lastProblems.current) setExpanded(true);
    lastProblems.current = info.problemCount;
  }, [info.problemCount]);

  if (!info.visible && leaving.length === 0) return null;

  const closeAll = () => {
    for (const op of ops) store.dismiss(op.id);
  };

  return (
    <div
      role="region"
      aria-label={labels.dockRegion}
      data-slot="file-ops-dock"
      className="fixed inset-x-3 bottom-24 z-40 xl:inset-x-auto xl:right-6 xl:bottom-28 xl:w-[400px]"
    >
      <Card padding={false}>
        <div className="flex items-center gap-2 p-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm">{info.title}</p>
            {!expanded && info.summary && <p className="truncate font-mono text-xs">{info.summary}</p>}
          </div>
          <Button
            variant="ghost"
            size="iconSm"
            surface="secondary"
            aria-label={expanded ? labels.hideDetails : labels.showDetails}
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? (
              <ChevronDown size={ICON_SIZE.md} aria-hidden="true" />
            ) : (
              <ChevronUp size={ICON_SIZE.md} aria-hidden="true" />
            )}
          </Button>
          {info.runningCount === 0 && (
            <Button variant="ghost" size="iconSm" surface="secondary" aria-label={labels.close} onClick={closeAll}>
              <X size={ICON_SIZE.md} aria-hidden="true" />
            </Button>
          )}
        </div>
        {expanded && (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto px-3 pb-3">
            {ops.map((op) => (
              <SlideCollapse key={op.id} show>
                <FileOpRow op={op} />
              </SlideCollapse>
            ))}
            {leaving.map((op) => (
              <SlideCollapse key={op.id} show={false}>
                <FileOpRow op={op} />
              </SlideCollapse>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
