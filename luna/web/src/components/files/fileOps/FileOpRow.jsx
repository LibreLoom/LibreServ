import { useState } from "react";
import PropTypes from "prop-types";
import { AlertTriangle } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { useFileOps } from "../../../context/FileOpsContext.jsx";
import { labels, moreProblems, opMeta, opStatus, plain } from "../../../lib/fileOps/copy.js";
import { inlineProblem, isRunning, opProgress } from "../../../lib/fileOps/selectors.js";
import FileOpItemLine from "./FileOpItemLine.jsx";
import FileOpParts from "./FileOpParts.jsx";
import FileOpProblemsModal from "./FileOpProblemsModal.jsx";
import FileOpProgress from "./FileOpProgress.jsx";

const MAX_ACTIVE_LINES = 3;

/**
 * One operation inside the dock: status line, meter, the files being sent,
 * and at most one problem (the oldest) with "N more problems →" behind it.
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
    <div data-slot="file-op-row" className="space-y-2 rounded-large-element surface-primary p-3">
      <div className="flex items-start gap-2">
        <p aria-live="polite" className="min-w-0 flex-1 break-words font-mono text-sm">
          <FileOpParts parts={status} />
        </p>
        {running && op.state !== "waiting" && (
          <Button variant="outline" size="sm" surface="primary" onClick={() => ops.cancel(op.id)}>
            {labels.cancel}
          </Button>
        )}
        {!running && problem && (
          <Button variant="outline" size="sm" surface="primary" onClick={() => ops.dismiss(op.id)}>
            {labels.clear}
          </Button>
        )}
      </div>

      {running && (
        <FileOpProgress pct={opProgress(op)} surface="primary" label={plain(status)} />
      )}
      {meta && <p className="font-mono text-xs">{meta}</p>}

      {op.error && (
        <p className="flex items-start gap-2 rounded-large-element border border-error/30 bg-error/20 p-3 text-sm">
          <AlertTriangle size={ICON_SIZE.md} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
          <span className="min-w-0 break-words">{op.error}</span>
        </p>
      )}

      {activeItems.map((item) => (
        <FileOpItemLine key={item.id} op={op} item={item} />
      ))}

      {problem && <FileOpItemLine op={op} item={problem} />}
      {moreCount > 0 && (
        <Button variant="ghost" size="sm" surface="primary" onClick={() => setModalOpen(true)}>
          {moreProblems(moreCount)}
        </Button>
      )}
      <FileOpProblemsModal opId={op.id} open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}

FileOpRow.propTypes = {
  op: PropTypes.object.isRequired,
};
