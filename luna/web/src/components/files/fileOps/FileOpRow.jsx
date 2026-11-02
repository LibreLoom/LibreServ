import { useState } from "react";
import PropTypes from "prop-types";
import { AnimatePresence, motion as Motion } from "motion/react";
import { AlertTriangle } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { useFileOps } from "../../../context/FileOpsContext.jsx";
import { labels, moreProblems, opMeta, opStatus, plain } from "../../../lib/fileOps/copy.js";
import {
  BAR_EXIT,
  BAR_HIDDEN,
  BAR_SHOWN,
  EXIT,
  LINE_EXIT,
  LINE_HIDDEN,
  LINE_SHOWN,
  SPRING,
  TEXT_EXIT,
} from "../../../lib/fileOps/motion.js";
import { inlineProblem, isRunning, opProgress } from "../../../lib/fileOps/selectors.js";
import FileOpItemLine from "./FileOpItemLine.jsx";
import FileOpParts from "./FileOpParts.jsx";
import FileOpProblemsModal from "./FileOpProblemsModal.jsx";
import FileOpProgress from "./FileOpProgress.jsx";

const MAX_ACTIVE_LINES = 3;

/**
 * One operation inside the dock: status line, meter, the files being sent,
 * and at most one problem (the oldest) with "N more problems →" behind it.
 *
 * Everything below the status line is conditional, so each piece animates its
 * own height in and out rather than appearing between frames. The row stacks
 * with no `space-y`: each animated piece carries its own top gap inside the
 * height it animates, so a piece that leaves takes its gap with it.
 *
 * @param {{ op: import("../../../lib/fileOps/store.js").Op }} props
 */
export default function FileOpRow({ op }) {
  const ops = useFileOps();
  const [modalOpen, setModalOpen] = useState(false);
  const running = isRunning(op) || op.state === "waiting";
  const status = opStatus(op);
  const { item: problem, moreCount } = inlineProblem(op);
  const meta = running ? opMeta(op) : "";
  const activeItems =
    running && (op.kind === "upload" || op.kind === "gallery")
      ? op.items.filter((item) => item.state === "uploading" || item.state === "finishing").slice(0, MAX_ACTIVE_LINES)
      : [];

  return (
    <div data-slot="file-op-row" className="rounded-large-element surface-primary p-3">
      <div className="flex items-start gap-2">
        {/* The status line swaps its words as the operation moves on. Keyed by
            the words themselves, so "Uploading" → "Uploaded" is a swap and a
            percentage ticking up is not. */}
        <p aria-live="polite" className="min-w-0 flex-1 break-words font-mono text-sm">
          <AnimatePresence mode="wait" initial={false}>
            <Motion.span
              key={plain(status)}
              initial={{ opacity: 0, y: "40%" }}
              animate={{ opacity: 1, y: "0%" }}
              exit={{ opacity: 0, y: "-40%", transition: TEXT_EXIT }}
              transition={SPRING}
              className="block"
            >
              <FileOpParts parts={status} />
            </Motion.span>
          </AnimatePresence>
        </p>
        <AnimatePresence initial={false}>
          {running && op.state !== "waiting" && (
            <Motion.div
              key="cancel"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: EXIT }}
              transition={SPRING}
              className="shrink-0"
            >
              <Button variant="outline" size="sm" surface="primary" onClick={() => ops.cancel(op.id)}>
                {labels.cancel}
              </Button>
            </Motion.div>
          )}
          {!running && problem && (
            <Motion.div
              key="clear"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: EXIT }}
              transition={SPRING}
              className="shrink-0"
            >
              <Button variant="outline" size="sm" surface="primary" onClick={() => ops.dismiss(op.id)}>
                {labels.clear}
              </Button>
            </Motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence initial={false}>
        {running && (
          <Motion.div
            key="progress"
            initial={BAR_HIDDEN}
            animate={BAR_SHOWN}
            exit={BAR_EXIT}
            transition={SPRING}
            className="overflow-hidden"
          >
            <FileOpProgress pct={opProgress(op)} surface="primary" label={plain(status)} />
          </Motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {meta && (
          <Motion.div
            key="meta"
            initial={LINE_HIDDEN}
            animate={LINE_SHOWN}
            exit={LINE_EXIT}
            transition={SPRING}
            className="overflow-hidden"
          >
            {/* The counter changes every emit; only the line's presence animates. */}
            <p className="font-mono text-xs">{meta}</p>
          </Motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {op.error && (
          <Motion.p
            key="error"
            initial={LINE_HIDDEN}
            animate={LINE_SHOWN}
            exit={LINE_EXIT}
            transition={SPRING}
            className="flex items-start gap-2 overflow-hidden rounded-large-element border border-error/30 bg-error/20 p-3 text-sm"
          >
            <AlertTriangle size={ICON_SIZE.md} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
            <span className="min-w-0 break-words">{op.error}</span>
          </Motion.p>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {activeItems.map((item) => (
          <Motion.div
            key={item.id}
            initial={LINE_HIDDEN}
            animate={LINE_SHOWN}
            exit={LINE_EXIT}
            transition={SPRING}
            className="overflow-hidden"
          >
            <FileOpItemLine op={op} item={item} />
          </Motion.div>
        ))}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {problem && (
          <Motion.div
            key="problem"
            initial={LINE_HIDDEN}
            animate={LINE_SHOWN}
            exit={LINE_EXIT}
            transition={SPRING}
            className="overflow-hidden"
          >
            <FileOpItemLine op={op} item={problem} />
          </Motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {moreCount > 0 && (
          <Motion.div
            key="more"
            initial={LINE_HIDDEN}
            animate={LINE_SHOWN}
            exit={LINE_EXIT}
            transition={SPRING}
            className="overflow-hidden"
          >
            <Button variant="ghost" size="sm" surface="primary" onClick={() => setModalOpen(true)}>
              {moreProblems(moreCount)}
            </Button>
          </Motion.div>
        )}
      </AnimatePresence>

      <FileOpProblemsModal opId={op.id} open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}

FileOpRow.propTypes = {
  op: PropTypes.object.isRequired,
};
