import PropTypes from "prop-types";
import { AlertTriangle, CircleAlert, X } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { useFileOps } from "../../../context/FileOpsContext.jsx";
import { cancelUploadAria, decisionButtons, decisionText, failedText, itemPercent, labels, text } from "../../../lib/fileOps/copy.js";
import FileOpParts from "./FileOpParts.jsx";
import FileOpProgress from "./FileOpProgress.jsx";

/**
 * One file inside an operation: a running upload, a name clash that needs an answer,
 * or a failure. Problem lines sit on a `surface-primary` backdrop (an operation row
 * or the problems list); a running line draws its own `surface-secondary` panel.
 * @param {{ op: import("../../../lib/fileOps/store.js").Op, item: import("../../../lib/fileOps/store.js").Item }} props
 */
export default function FileOpItemLine({ op, item }) {
  const ops = useFileOps();

  if (item.state === "needs-decision" && item.decision) {
    const buttons = decisionButtons(op, item);
    return (
      <div
        data-slot="file-op-decision"
        className="space-y-2 rounded-large-element border border-warning/30 bg-warning/20 p-3"
      >
        <p className="flex items-start gap-2 text-sm">
          <CircleAlert size={ICON_SIZE.md} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 break-words">
            <FileOpParts parts={decisionText(op, item)} />
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {buttons.map((button) => (
            <span key={button.choice} className="inline-flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                surface="primary"
                onClick={() => ops.decide(op.id, item.id, button.choice)}
              >
                {button.label}
              </Button>
              {button.hint && <InfoHint surface="primary" content={button.hint} label={`About ${button.label}`} />}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (item.state === "failed") {
    const message = item.error || (item.offline ? text.offline : failedText(op.kind));
    return (
      <div
        data-slot="file-op-failed"
        className="space-y-2 rounded-large-element border border-error/30 bg-error/20 p-3"
      >
        <p className="flex items-start gap-2 text-sm">
          <AlertTriangle size={ICON_SIZE.md} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
          <span className="min-w-0 break-words">
            <InlinePill>{item.name}</InlinePill> {message}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {item.retryable && (
            <Button variant="outline" size="sm" surface="primary" onClick={() => ops.retry(op.id, item.id)}>
              {labels.tryAgain}
            </Button>
          )}
          <Button variant="ghost" size="sm" surface="primary" onClick={() => ops.cancel(op.id, item.id)}>
            {labels.remove}
          </Button>
        </div>
      </div>
    );
  }

  // Running (or waiting to start): name, percent, cancel.
  const pct = itemPercent(item);
  return (
    <div data-slot="file-op-active" className="space-y-1.5 rounded-large-element surface-secondary p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
        {item.retrying ? (
          <span className="font-mono text-xs">{text.connectionLost}</span>
        ) : (
          <span className="font-mono text-xs">{pct}%</span>
        )}
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

FileOpItemLine.propTypes = {
  op: PropTypes.object.isRequired,
  item: PropTypes.object.isRequired,
};
