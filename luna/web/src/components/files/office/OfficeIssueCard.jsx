import PropTypes from "prop-types";
import { Download, RotateCcw, X } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";

/**
 * Shared card for office-open failures — identical chrome whether the
 * EuroOffice pack is missing (OfficeEditor) or a file couldn't be opened
 * (EuroOfficeHost), so the two never read as different kinds of broken.
 * Always offers the two things a person can actually do next: download the
 * file, or close.
 *
 * @param {{
 *   title: string,
 *   children: import("react").ReactNode,
 *   downloadUrl: string,
 *   downloadName: string,
 *   onClose?: () => void,
 *   onRetry?: () => void,
 * }} props
 */
export default function OfficeIssueCard({ title, children, downloadUrl, downloadName, onClose, onRetry }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center surface-primary p-6">
      <div className="w-full max-w-md rounded-large-element surface-secondary p-6">
        <p className="font-mono text-base">{title}</p>
        <div className="mt-2 text-sm">{children}</div>
        <div className="mt-5 flex flex-wrap gap-2">
          {onRetry ? (
            <Button variant="primary" surface="secondary" haptic="light" onClick={onRetry}>
              <RotateCcw size={16} aria-hidden="true" />
              Reopen
            </Button>
          ) : null}
          {downloadUrl ? (
            <Button asChild variant="primary" surface="secondary" haptic="light">
              <a href={downloadUrl} download={downloadName || ""}>
                <Download size={16} aria-hidden="true" />
                Download
              </a>
            </Button>
          ) : null}
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

OfficeIssueCard.propTypes = {
  title: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
  downloadUrl: PropTypes.string,
  downloadName: PropTypes.string,
  onClose: PropTypes.func,
  onRetry: PropTypes.func,
};
