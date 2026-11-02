import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { AnimatePresence, MotionConfig, motion as Motion } from "motion/react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { useFileOps, useFileOpsState } from "../../../context/FileOpsContext.jsx";
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
 * @param {{ expanded?: boolean, onExpandedChange?: (open: boolean) => void }} props
 *   `expanded` makes the open state controlled. The playground uses it to fire
 *   the collapse transition on demand; the app leaves both unset.
 */
export default function FileOpsDock({ expanded: expandedProp, onExpandedChange }) {
  const store = useFileOps();
  const ops = useFileOpsState(visibleOps);
  const info = useFileOpsState(dockInfo);
  const [expandedState, setExpandedState] = useState(startsExpanded);
  const controlled = expandedProp !== undefined;
  const expanded = controlled ? expandedProp : expandedState;
  // Stable, so the effect below can depend on it honestly instead of silencing
  // the lint. `expanded` is read through a ref for the same reason.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const setExpanded = useCallback(
    (/** @type {boolean | ((open: boolean) => boolean)} */ next) => {
      const value = typeof next === "function" ? next(expandedRef.current) : next;
      if (!controlled) setExpandedState(value);
      onExpandedChange?.(value);
    },
    [controlled, onExpandedChange],
  );
  const lastProblems = useRef(0);

  // The last header that had words in it. Read only while the card is leaving,
  // because that is exactly when `info` has nothing left to say.
  const held = useRef({ title: "", summary: "" });
  const title = info.title || held.current.title;
  const summary = info.summary || held.current.summary;

  useEffect(() => {
    if (info.title) held.current = { title: info.title, summary: info.summary };
  }, [info.title, info.summary]);

  // Open by itself when a new problem shows up.
  useEffect(() => {
    if (info.problemCount > lastProblems.current) setExpanded(true);
    lastProblems.current = info.problemCount;
  }, [info.problemCount, setExpanded]);

  const closeAll = () => {
    for (const op of ops) store.dismiss(op.id);
  };

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
                  <Motion.p layout="position" className="truncate font-mono text-sm">
                    {title}
                  </Motion.p>
                  <AnimatePresence initial={false}>
                    {!expanded && summary && (
                      <Motion.p
                        key="summary"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={SPRING}
                        className="overflow-hidden"
                      >
                        <span className="block truncate font-mono text-xs">{summary}</span>
                      </Motion.p>
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
                {info.runningCount === 0 && (
                  <Button
                    variant="ghost"
                    size="iconSm"
                    surface="secondary"
                    aria-label={labels.close}
                    onClick={closeAll}
                  >
                    <X size={ICON_SIZE.md} aria-hidden="true" />
                  </Button>
                )}
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
                    <div className="max-h-[60vh] overflow-y-auto px-3 pb-3">
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
                            {/* The gap lives inside the animated height, so a
                                collapsed row leaves no hole behind it. */}
                            <div className="pb-2">
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

FileOpsDock.propTypes = {
  expanded: PropTypes.bool,
  onExpandedChange: PropTypes.func,
};
