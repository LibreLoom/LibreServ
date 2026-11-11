import PropTypes from "prop-types";
import { AnimatePresence, motion as Motion } from "motion/react";
import { AlertTriangle, CircleAlert, X } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { useFileOps } from "../../../context/FileOpsContext.jsx";
import { cancelUploadAria, decisionButtons, decisionText, failedText, itemPercent, labels, text } from "../../../lib/fileOps/copy.js";
import { EXIT, ITEM_EXIT, ITEM_HIDDEN, ITEM_SHOWN, SPRING } from "../../../lib/fileOps/motion.js";
import FileOpParts from "./FileOpParts.jsx";
import FileOpProgress from "./FileOpProgress.jsx";
import PercentPill from "./PercentPill.jsx";

/**
 * A name clash that needs an answer.
 *
 * A button that needs explaining is its own term: the label carries a dotted
 * underline and the explanation opens from the button itself. The old shape
 * put a little ⓘ beside each button, which broke the row into
 * button-icon-button-icon and read as five things instead of three.
 *
 * `Tooltip` wraps its child in a span, so the Button stays the only control —
 * `TermHint` would have put a <button> inside a <button>.
 */
function DecisionLine({ op, item }) {
  const ops = useFileOps();
  const buttons = decisionButtons(op, item);
  return (
    <div className="space-y-2 rounded-large-element border border-warning/30 bg-warning/20 p-3">
      <p className="flex items-start gap-2 text-sm">
        <CircleAlert size={ICON_SIZE.md} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 break-words">
          <FileOpParts parts={decisionText(op, item)} />
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {buttons.map((button) =>
          button.hint ? (
            <Tooltip
              key={button.choice}
              surface="primary"
              content={button.hint}
              popupClassName="max-w-xs rounded-large-element px-3 py-1.5 text-xs leading-snug"
            >
              <Button
                variant="outline"
                size="sm"
                surface="primary"
                onClick={() => ops.decide(op.id, item.id, button.choice)}
              >
                <span className="underline decoration-dotted decoration-2 underline-offset-4">
                  {button.label}
                </span>
              </Button>
            </Tooltip>
          ) : (
            <Button
              key={button.choice}
              variant="outline"
              size="sm"
              surface="primary"
              onClick={() => ops.decide(op.id, item.id, button.choice)}
            >
              {button.label}
            </Button>
          ),
        )}
      </div>
    </div>
  );
}

DecisionLine.propTypes = {
  op: PropTypes.object.isRequired,
  item: PropTypes.object.isRequired,
};

/** A file that didn't make it. */
function FailedLine({ op, item }) {
  const ops = useFileOps();
  const message = item.error || (item.offline ? text.offline : failedText(op.kind));
  return (
    <div className="space-y-2 rounded-large-element border border-error/30 bg-error/20 p-3">
      <p className="flex items-start gap-2 text-sm">
        <AlertTriangle size={ICON_SIZE.md} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
        <span className="min-w-0 break-words">
          <InlinePill>{item.name}</InlinePill> {message}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <AnimatePresence initial={false}>
          {item.retryable && (
            <Motion.span
              key="retry"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: EXIT }}
              transition={SPRING}
            >
              <Button variant="outline" size="sm" surface="primary" onClick={() => ops.retry(op.id, item.id)}>
                {labels.tryAgain}
              </Button>
            </Motion.span>
          )}
        </AnimatePresence>
        <Button variant="outline" size="sm" surface="primary" onClick={() => ops.cancel(op.id, item.id)}>
          {labels.remove}
        </Button>
      </div>
    </div>
  );
}

FailedLine.propTypes = {
  op: PropTypes.object.isRequired,
  item: PropTypes.object.isRequired,
};

/** A file being sent right now. */
function ActiveLine({ op, item }) {
  const ops = useFileOps();
  const pct = itemPercent(item);
  return (
    <div className="space-y-1.5 rounded-large-element surface-secondary p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
        {/* The percentage counts up on every progress emit, so it must not
            animate; "Connection lost" replacing it is a real state change and
            does. */}
        <AnimatePresence mode="wait" initial={false}>
          {item.retrying ? (
            <Motion.span
              key="retrying"
              initial={{ opacity: 0, y: "40%" }}
              animate={{ opacity: 1, y: "0%" }}
              exit={{ opacity: 0, y: "-40%", transition: EXIT }}
              transition={SPRING}
              className="shrink-0 font-mono text-xs"
            >
              {text.connectionLost}
            </Motion.span>
          ) : (
            <Motion.span
              key="pct"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: EXIT }}
              transition={{ duration: 0.15 }}
              className="shrink-0"
            >
              <PercentPill value={pct} />
            </Motion.span>
          )}
        </AnimatePresence>
        <Button
          variant="ghost"
          size="iconSm"
          surface="secondary"
          aria-label={cancelUploadAria(item.name)}
          onClick={() => ops.cancel(op.id, item.id)}
        >
          <X size={ICON_SIZE.md} aria-hidden="true" />
        </Button>
      </div>
      <FileOpProgress pct={pct} surface="secondary" label={`Uploading ${item.name}`} />
    </div>
  );
}

ActiveLine.propTypes = {
  op: PropTypes.object.isRequired,
  item: PropTypes.object.isRequired,
};

/**
 * One file inside an operation: a running upload, a name clash that needs an
 * answer, or a failure. Problem lines sit on a `surface-primary` backdrop (an
 * operation row or the problems list); a running line draws its own
 * `surface-secondary` panel.
 *
 * An item changes what it is as it goes — running, then a clash, then running
 * again, then failed — and the row should read as the same file moving on.
 * `mode="wait"` swaps the two shapes rather than overlapping them: the old one
 * leaves upward, the new one rises from below, and the height follows.
 *
 * @param {{ op: import("../../../lib/fileOps/store.js").Op, item: import("../../../lib/fileOps/store.js").Item }} props
 */
export default function FileOpItemLine({ op, item }) {
  // Which of the three shapes this item is in right now. `needs-decision`
  // without a decision is still a problem, so it falls through to "failed".
  const shape =
    item.state === "needs-decision" && item.decision
      ? "decision"
      : item.state === "failed"
        ? "failed"
        : "active";

  return (
    <AnimatePresence mode="wait" initial={false}>
      <Motion.div
        key={shape}
        data-slot={`file-op-${shape}`}
        initial={ITEM_HIDDEN}
        animate={ITEM_SHOWN}
        exit={ITEM_EXIT}
        transition={SPRING}
      >
        {shape === "decision" && <DecisionLine op={op} item={item} />}
        {shape === "failed" && <FailedLine op={op} item={item} />}
        {shape === "active" && <ActiveLine op={op} item={item} />}
      </Motion.div>
    </AnimatePresence>
  );
}

FileOpItemLine.propTypes = {
  op: PropTypes.object.isRequired,
  item: PropTypes.object.isRequired,
};
