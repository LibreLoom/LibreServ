import { useRef, useState } from "react";
import PropTypes from "prop-types";
import { UploadCloud } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";
import { apiErrorMessage } from "../../lib/api.js";
import { filesFromDataTransfer } from "../../lib/collectUploadFiles.js";
import { hasLunaPaths, hasOsFiles, readLunaDrive, readLunaPaths } from "../../lib/dnd.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/**
 * @param {{
 *   onUploadFiles: (files: File[]) => void | Promise<void>,
 *   onMovePaths?: (paths: string[], sourceDriveId?: string) => void,
 *   busy?: boolean,
 *   error?: string | null,
 *   accept?: string,
 *   title?: string,
 *   children?: import("react").ReactNode,
 * }} props
 */
export default function UploadFilesPanel({
  onUploadFiles,
  onMovePaths,
  busy = false,
  error = null,
  accept,
  title = "Upload files",
  children,
}) {
  const [dragOver, setDragOver] = useState(false);
  const [localError, setLocalError] = useState(/** @type {string|null} */ (null));
  const fileInputRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  const shownError = error || localError;

  /** @param {File[]} files */
  async function handleFiles(files) {
    if (!files.length) return;
    setLocalError(null);
    try {
      await onUploadFiles(files);
    } catch (err) {
      setLocalError(apiErrorMessage(err, "Couldn't upload those files. Try again."));
    }
  }

  return (
    <Card title={title}>
      {shownError && <PageNotice variant="error" className="mb-3">{shownError}</PageNotice>}
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-large-element border-2 border-dashed border-secondary/30 bg-primary p-8 text-secondary motion-safe:transition-colors motion-safe:duration-150",
          dragOver && "border-accent bg-[color-mix(in_srgb,var(--accent)_20%,var(--primary))]",
          busy && "opacity-70",
        )}
        onDragOver={(e) => {
          if (busy) return;
          const isLuna = Boolean(onMovePaths) && hasLunaPaths(e);
          if (!isLuna && !hasOsFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = isLuna ? "move" : "copy";
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          // Ignore leave events that stay within the zone (child→child).
          if (e.currentTarget.contains(/** @type {Node|null} */ (e.relatedTarget))) return;
          setDragOver(false);
        }}
        onDrop={async (e) => {
          e.preventDefault();
          setDragOver(false);
          if (busy) return;
          haptic("heavy");
          const files = await filesFromDataTransfer(e.dataTransfer);
          if (files.length) {
            await handleFiles(files);
            return;
          }
          if (onMovePaths && hasLunaPaths(e)) {
            onMovePaths(readLunaPaths(e.dataTransfer), readLunaDrive(e.dataTransfer));
          }
        }}
      >
        <UploadCloud size={22} className="text-accent" aria-hidden="true" />
        <span className="text-sm">Choose files or drop them here</span>
        <Button
          variant="outline"
          surface="primary"
          size="sm"
          type="button"
          disabled={busy}
          onClick={() => {
            haptic("light");
            fileInputRef.current?.click();
          }}
        >
          Choose files
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={accept}
          disabled={busy}
          className="hidden"
          aria-label="Add files"
          onChange={async (e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = "";
            await handleFiles(files);
          }}
        />
      </div>
      {children}
    </Card>
  );
}

UploadFilesPanel.propTypes = {
  onUploadFiles: PropTypes.func.isRequired,
  onMovePaths: PropTypes.func,
  busy: PropTypes.bool,
  error: PropTypes.string,
  accept: PropTypes.string,
  title: PropTypes.string,
  children: PropTypes.node,
};
