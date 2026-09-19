import PropTypes from "prop-types";
import { Download, RotateCcw, X } from "lucide-react";
import Button from "../../ui/Button.jsx";

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
    <div className="flex min-h-0 flex-1 items-center justify-center bg-primary p-6 text-secondary">
      <div className="w-full max-w-md rounded-large-element bg-secondary p-6 text-primary">
        <p className="font-mono text-base">{title}</p>
        <div className="mt-2 text-sm">{children}</div>
        <div className="mt-5 flex flex-wrap gap-2">
          {onRetry ? (
            <Button variant="primary" surface="secondary" haptic="light" onClick={onRetry}>
              <RotateCcw size={16} aria-hidden="true" />
              Reopen
            </Button>
          ) : null}
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

OfficeIssueCard.propTypes = {
  title: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
  downloadUrl: PropTypes.string.isRequired,
  downloadName: PropTypes.string.isRequired,
  onClose: PropTypes.func,
  onRetry: PropTypes.func,
};
