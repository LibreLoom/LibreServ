import PropTypes from "prop-types";
import { Download, Eye, X } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";

/**
 * HACK (part of the advisory .drawio edit lock — see useDiagramLock.js):
 * shown when someone else holds the lock. Same chrome as OfficeIssueCard,
 * plus the one extra action a lock makes possible — open read-only.
 *
 * @param {{
 *   holderName: string,
 *   selfHold?: boolean,
 *   downloadUrl: string,
 *   downloadName: string,
 *   onOpenReadOnly: () => void,
 *   onClose?: () => void,
 * }} props
 */
export default function DiagramLockedCard({
  holderName,
  selfHold = false,
  downloadUrl,
  downloadName,
  onOpenReadOnly,
  onClose,
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-primary p-6 text-secondary">
      <div className="w-full max-w-md rounded-large-element bg-secondary p-6 text-primary">
        <p className="font-mono text-base">
          {selfHold
            ? "You're already editing this diagram"
            : `${holderName} is editing this diagram`}
        </p>
        <div className="mt-2 text-sm">
          <p>
            {selfHold
              ? "It's open for editing in another tab or on another device. If you both save changes, one of you loses their work. You can open it read-only, download a copy, or close it there first."
              : "If you both save changes, one of you loses their work. You can open it read-only, download a copy, or try again after they close it."}
          </p>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="primary"
            surface="secondary"
            haptic="light"
            onClick={onOpenReadOnly}
          >
            <Eye size={16} aria-hidden="true" />
            Open read-only
          </Button>
          <Button asChild variant="primary" surface="secondary" haptic="light">
            <a href={downloadUrl} download={downloadName}>
              <Download size={16} aria-hidden="true" />
              Download
            </a>
          </Button>
          {onClose ? (
            <Button variant="outline" surface="secondary" haptic="light" onClick={onClose}>
              <X size={16} aria-hidden="true" />
              Close
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

DiagramLockedCard.propTypes = {
  holderName: PropTypes.string.isRequired,
  selfHold: PropTypes.bool,
  downloadUrl: PropTypes.string.isRequired,
  downloadName: PropTypes.string.isRequired,
  onOpenReadOnly: PropTypes.func.isRequired,
  onClose: PropTypes.func,
};
