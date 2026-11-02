import PropTypes from "prop-types";
import { AnimatePresence, motion as Motion } from "motion/react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { useFileOps, useFileOpsState } from "../../../context/FileOpsContext.jsx";
import { labels, problemsTitle } from "../../../lib/fileOps/copy.js";
import { EXIT, ROW_EXIT, ROW_HIDDEN, ROW_SHOWN, SPRING } from "../../../lib/fileOps/motion.js";
import { opById, problemItems } from "../../../lib/fileOps/selectors.js";
import FileOpItemLine from "./FileOpItemLine.jsx";

const canOffer = (items, choice) =>
  items.some(
    (item) =>
      item.state === "needs-decision" &&
      item.decision?.type === "exists" &&
      item.decision.options.includes(choice),
  );

/**
 * Every problem of one operation, each with its own buttons, plus the bulk buttons
 * that apply. Nothing else in the operation pauses while it is open.
 * @param {{ opId: string, open: boolean, onClose: () => void }} props
 */
export default function FileOpProblemsModal({ opId, open, onClose }) {
  const ops = useFileOps();
  const op = useFileOpsState((state) => opById(state, opId));
  const problems = op ? problemItems(op) : [];
  if (!op) return null;

  const waiting = problems.filter((item) => item.state === "needs-decision");
  const failed = problems.filter((item) => item.state === "failed");
  const showReplace = canOffer(waiting, "replace");
  const showKeep = canOffer(waiting, "keep_both");
  const showSkip = waiting.length > 0;
  const showRetry = failed.some((item) => item.retryable);
  const hasClashes = showReplace || showKeep;

  const footer = (
    <div className="space-y-2">
      <AnimatePresence initial={false}>
        {hasClashes && (
          <Motion.p
            key="applies"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0, transition: EXIT }}
            transition={SPRING}
            className="overflow-hidden text-sm"
          >
            {labels.appliesToRest}
          </Motion.p>
        )}
      </AnimatePresence>
      <div className="flex flex-wrap gap-2">
        <AnimatePresence initial={false}>
          {showReplace && (
            <Motion.span
              key="replace"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: EXIT }}
              transition={SPRING}
            >
              <Button variant="outline" size="sm" surface="secondary" onClick={() => ops.decideAll(op.id, "replace")}>
                {labels.replaceAll}
              </Button>
            </Motion.span>
          )}
          {showKeep && (
            <Motion.span
              key="keep"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: EXIT }}
              transition={SPRING}
            >
              <Button variant="outline" size="sm" surface="secondary" onClick={() => ops.decideAll(op.id, "keep_both")}>
                {labels.keepBothAll}
              </Button>
            </Motion.span>
          )}
          {showSkip && (
            <Motion.span
              key="skip"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: EXIT }}
              transition={SPRING}
            >
              <Button variant="outline" size="sm" surface="secondary" onClick={() => ops.decideAll(op.id, "skip")}>
                {labels.skipAll}
              </Button>
            </Motion.span>
          )}
          {showRetry && (
            <Motion.span
              key="retry"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: EXIT }}
              transition={SPRING}
            >
              <Button variant="outline" size="sm" surface="secondary" onClick={() => ops.retry(op.id)}>
                {labels.tryAllAgain}
              </Button>
            </Motion.span>
          )}
          {failed.length > 0 && (
            <Motion.span
              key="clear"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: EXIT }}
              transition={SPRING}
            >
              <Button variant="ghost" size="sm" surface="secondary" onClick={() => ops.clearFailed(op.id)}>
                {labels.clearFailed}
              </Button>
            </Motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );

  return (
    <ModalCard
      open={open && problems.length > 0}
      title={problemsTitle(op.kind)}
      onClose={onClose}
      footer={hasClashes || failed.length > 0 ? footer : undefined}
    >
      <div className="max-h-[50vh] overflow-y-auto rounded-large-element surface-primary p-3">
        {/* Answering one clash removes its row; the rest close the gap. */}
        <AnimatePresence initial={false}>
          {problems.map((item) => (
            <Motion.div
              key={item.id}
              initial={ROW_HIDDEN}
              animate={ROW_SHOWN}
              exit={ROW_EXIT}
              transition={SPRING}
              className="overflow-hidden"
            >
              <div className="pb-2">
                <FileOpItemLine op={op} item={item} />
              </div>
            </Motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ModalCard>
  );
}

FileOpProblemsModal.propTypes = {
  opId: PropTypes.string.isRequired,
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
