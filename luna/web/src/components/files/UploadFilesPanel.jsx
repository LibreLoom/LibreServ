import { useRef, useState } from "react";
import PropTypes from "prop-types";
import { FolderUp, UploadCloud } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";
import { filesFromFileList, takeDropped } from "../../lib/collectUploadFiles.js";
import { hasLunaPaths, hasOsFiles, readLunaDrive, readLunaPaths } from "../../lib/dnd.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/** `webkitdirectory` picks a whole folder; React's input types don't list it. */
const FOLDER_INPUT = { webkitdirectory: "" };

/**
 * @param {{
 *   onUploadFiles: (input: { dropped: import("../../lib/collectUploadFiles.js").DroppedItems } | { files: File[] }) => void,
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
  const fileInputRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  const folderInputRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  const canPickFolder = typeof document !== "undefined" && "webkitdirectory" in document.createElement("input");
  // Upload problems show in the file tasks card, not here.
  const shownError = error;

  return (
    <Card title={title}>
      {shownError && <PageNotice variant="error" className="mb-3">{shownError}</PageNotice>}
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-large-element border-2 border-dashed border-secondary/30 surface-primary p-8 motion-safe:transition-colors motion-safe:duration-150",
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
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (busy) return;
          haptic("heavy");
          // Take the dropped entries now: the browser only allows it during the event.
          const dropped = takeDropped(e.dataTransfer);
          if (dropped.entries.length || dropped.files.length) {
            onUploadFiles({ dropped });
            return;
          }
          if (onMovePaths && hasLunaPaths(e)) {
            onMovePaths(readLunaPaths(e.dataTransfer), readLunaDrive(e.dataTransfer));
          }
        }}
      >
        <UploadCloud size={22} aria-hidden="true" />
        <span className="text-sm">Choose files or drop them here</span>
        <div className="flex flex-wrap items-center justify-center gap-2">
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
          {canPickFolder ? (
            <Button
              variant="outline"
              surface="primary"
              size="sm"
              type="button"
              disabled={busy}
              onClick={() => {
                haptic("light");
                folderInputRef.current?.click();
              }}
            >
              <FolderUp size={14} aria-hidden="true" />
              Choose a folder
            </Button>
          ) : null}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={accept}
          disabled={busy}
          className="hidden"
          aria-label="Add files"
          onChange={(e) => {
            const files = filesFromFileList(e.target.files);
            e.target.value = "";
            if (files.length) onUploadFiles({ files });
          }}
        />
        {canPickFolder ? (
          <input
            ref={folderInputRef}
            type="file"
            multiple
            {...FOLDER_INPUT}
            disabled={busy}
            className="hidden"
            aria-label="Add a folder"
            onChange={(e) => {
              const files = filesFromFileList(e.target.files);
              e.target.value = "";
              if (files.length) onUploadFiles({ files });
            }}
          />
        ) : null}
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
