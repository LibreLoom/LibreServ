import PropTypes from "prop-types";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { useFileOps, useFileOpsState } from "../../../context/FileOpsContext.jsx";
import { labels, problemsTitle } from "../../../lib/fileOps/copy.js";
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
      {hasClashes && <p className="text-sm">{labels.appliesToRest}</p>}
      <div className="flex flex-wrap gap-2">
        {showReplace && (
          <Button variant="outline" size="sm" surface="secondary" onClick={() => ops.decideAll(op.id, "replace")}>
            {labels.replaceAll}
          </Button>
        )}
        {showKeep && (
          <Button variant="outline" size="sm" surface="secondary" onClick={() => ops.decideAll(op.id, "keep_both")}>
            {labels.keepBothAll}
          </Button>
        )}
        {showSkip && (
          <Button variant="outline" size="sm" surface="secondary" onClick={() => ops.decideAll(op.id, "skip")}>
            {labels.skipAll}
          </Button>
        )}
        {showRetry && (
          <Button variant="outline" size="sm" surface="secondary" onClick={() => ops.retry(op.id)}>
            {labels.tryAllAgain}
          </Button>
        )}
        {failed.length > 0 && (
          <Button variant="ghost" size="sm" surface="secondary" onClick={() => ops.clearFailed(op.id)}>
            {labels.clearFailed}
          </Button>
        )}
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
      <div className="max-h-[50vh] space-y-2 overflow-y-auto rounded-large-element surface-primary p-3">
        {problems.map((item) => (
          <FileOpItemLine key={item.id} op={op} item={item} />
        ))}
      </div>
    </ModalCard>
  );
}

FileOpProblemsModal.propTypes = {
  opId: PropTypes.string.isRequired,
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
