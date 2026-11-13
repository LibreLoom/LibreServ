import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { AnimatePresence, MotionConfig, motion as Motion } from "motion/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import RollingNumber from "@libreloom/ui/components/common/RollingNumber.jsx";
import { useFileOpsState } from "../../../context/FileOpsContext.jsx";
import { labels } from "../../../lib/fileOps/copy.js";
import {
  DOCK_EXIT,
  DOCK_HIDDEN,
  DOCK_SHOWN,
  DOCK_SPRING,
  ROW_EXIT,
  ROW_HIDDEN,
  ROW_SHOWN,
  SPRING,
} from "../../../lib/fileOps/motion.js";
import { dockInfo, visibleOps } from "../../../lib/fileOps/selectors.js";
import PercentPill from "./PercentPill.jsx";
import RollingText from "./RollingText.jsx";
import FileOpRow from "./FileOpRow.jsx";

/**
 * The card always starts collapsed. It is a status surface over a page someone
 * is using, so it earns its space by being opened — and a finished operation
 * shouldn't unfold a panel they then have to close.
 */
function startsExpanded() {
  return false;
}

/**
 * The collapsed summary, built so only what changed moves.
 *
 * The words ("Uploading", "finished", "needs you") slide to their new text;
 * the number beside them rolls like the file explorer's selection count. A
 * percentage that ticks ten times a second therefore animates nothing — it
 * just counts — while "Uploading" becoming "12 files uploaded" is a swap you
 * can see.
 *
 * @param {{ parts: any }} props
 */
function SummaryLine({ parts }) {
  const { lead, count, unit, pct, need } = parts;
  // The odometer draws all ten digits of every column, so its DOM text is not
  // the number. Screen readers get the plain sentence; the visible line is
  // aria-hidden, exactly as the file explorer's selection count does it.
  const spoken = `${lead}${count ?? ""}${unit}${
    pct != null ? ` · ${Math.round(pct)}%` : ""
  }${need > 0 ? ` · ${need} need you` : ""}`;
  return (
    <span className="block font-mono text-xs">
      <span className="sr-only" role="status">{spoken}</span>
      {/* One line, one flow: the words swap as a unit, the numbers roll in
          place, and nothing may wrap — a wrapped "·" reads as a stray bullet. */}
      <span aria-hidden="true" className="block truncate whitespace-nowrap">
        <RollingText value={parts.key}>
          {lead}
          {count != null && <RollingNumber value={count} />}
          {unit}
        </RollingText>
        {pct != null && (
          <>
            {" · "}
            <PercentPill value={Math.round(pct)} />
          </>
        )}
        {need > 0 && !lead && count == null && <> · {need} need you</>}
      </span>
    </span>
  );
}

SummaryLine.propTypes = {
  parts: PropTypes.object.isRequired,
};

/**
 * The file task card: every running or troubled file operation of this tab,
 * above the navbar on every in-app page. Renders nothing when there is none.
 *
 * Motion is the whole point of this component's shape. Three things it has to
 * get right, and did not before:
 *
 * 1. **The card leaves as a card.** It used to return `null` the moment the
 *    last operation went, so the card vanished between frames. Now the outer
 *    `AnimatePresence` keeps it mounted for its exit.
 * 2. **The header keeps its words while leaving.** `dockInfo` recomputes from
 *    the operations, so an empty list gives an empty title — which is what
 *    made the card collapse to a blank bar, then disappear. `held` keeps the
 *    last real header for the length of the exit.
 * 3. **Rows collapse vertically.** They used to be wrapped in `SlideCollapse`,
 *    which animates `grid-template-columns`: in a vertical stack that squeezes
 *    a row's width instead of its height, so a leaving row never gave its
 *    space back. Each row now animates its own height.
 *
 * The open state is this component's own, and only the chevron changes it.
 * Nothing else may unfold the card: not a new problem, not a caller, not a
 * prop. Someone reading the page decides when the details appear.
 */
export default function FileOpsDock() {
  const ops = useFileOpsState(visibleOps);
  const info = useFileOpsState(dockInfo);
  const [expanded, setExpanded] = useState(startsExpanded);
  // The last header that had words in it. Read only while the card is leaving,
  // because that is exactly when `info` has nothing left to say.
  const held = useRef({ title: "", summary: "", parts: null });
  const title = info.title || held.current.title;
  const summary = info.summary || held.current.summary;
  const summaryParts = info.parts || held.current.parts;

  useEffect(() => {
    if (info.title) {
      held.current = { title: info.title, summary: info.summary, parts: info.parts };
    }
  }, [info.title, info.summary, info.parts]);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {info.visible && (
          <Motion.div
            key="file-ops-dock"
            role="region"
            aria-label={labels.dockRegion}
            data-slot="file-ops-dock"
            initial={DOCK_HIDDEN}
            animate={DOCK_SHOWN}
            exit={DOCK_EXIT}
            transition={DOCK_SPRING}
            className="fixed inset-x-3 bottom-24 z-40 xl:inset-x-auto xl:right-6 xl:bottom-28 xl:w-[400px]"
          >
            <Card padding={false} noPopIn noHeightAnim className="border-2 border-accent">
              <div className="flex items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  {/* The title swaps its words rather than snapping. `block`
                      (not the inline default) so `truncate` can clip a long
                      one, and the summary sits under it as its own line. */}
                  <RollingText value={title} className="block truncate font-mono text-sm" />
                  <AnimatePresence initial={false}>
                    {!expanded && summary && (
                      <Motion.div
                        key="summary"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={SPRING}
                        className="overflow-hidden"
                      >
                        <SummaryLine parts={summaryParts} />
                      </Motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <Button
                  variant="ghost"
                  size="iconSm"
                  surface="secondary"
                  aria-label={expanded ? labels.hideDetails : labels.showDetails}
                  aria-expanded={expanded}
                  onClick={() => setExpanded((open) => !open)}
                >
                  <Motion.span
                    animate={{ rotate: expanded ? 0 : 180 }}
                    transition={SPRING}
                    className="flex"
                  >
                    {expanded ? (
                      <ChevronDown size={ICON_SIZE.md} aria-hidden="true" />
                    ) : (
                      <ChevronUp size={ICON_SIZE.md} aria-hidden="true" />
                    )}
                  </Motion.span>
                </Button>
              </div>
              <AnimatePresence initial={false}>
                {expanded && (
                  <Motion.div
                    key="rows"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={SPRING}
                    className="overflow-hidden"
                  >
                    <div className="max-h-[60vh] overflow-y-auto px-3">
                      <AnimatePresence initial={false}>
                        {ops.map((op) => (
                          <Motion.div
                            key={op.id}
                            initial={ROW_HIDDEN}
                            animate={ROW_SHOWN}
                            exit={ROW_EXIT}
                            transition={SPRING}
                            className="overflow-hidden"
                          >
                            {/* The gap is inside the animated height, so a
                                collapsed row leaves no hole behind it. It
                                matches the header's padding, so the space
                                above, between and below rows is all 12px. */}
                            <div className="pb-3">
                              <FileOpRow op={op} />
                            </div>
                          </Motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  </Motion.div>
                )}
              </AnimatePresence>
            </Card>
          </Motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
