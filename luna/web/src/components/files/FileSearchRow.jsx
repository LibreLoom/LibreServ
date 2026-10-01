import { Link } from "react-router-dom";
import {
  Copy,
  Download,
  File as FileIcon,
  Folder,
  FolderInput,
  FolderOpen,
  Trash2,
} from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { ActionTooltipGroup, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { ShareButton } from "../share/ShareSheet.jsx";
import { highlightParts } from "../../lib/fileSearch.js";
import { canViewerOpen } from "../../lib/officeConvert.js";
import { downloadHref, fileHref, parentPath, searchResultHref } from "../../lib/paths";
import { capsOnPath, memberFileHref, memberSearchHref } from "../../lib/shareTree.js";
import { CAP } from "../../lib/access.js";
import { cn } from "@libreloom/ui/lib/utils.js";

function folderOf(path) {
  return parentPath(path) ?? "";
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1000 / 1000).toFixed(1)} MB`;
  return `${(n / 1000 / 1000 / 1000).toFixed(1)} GB`;
}

function locationLabel(item, driveLabel) {
  const folder = item.parent != null ? item.parent : folderOf(item.path);
  if (!folder) return driveLabel;
  return `${driveLabel} / ${folder}`;
}

/**
 * One search hit: a stretched link that opens it, plus the same actions a
 * file row has (open, download, share, copy, move, trash).
 *
 * @param {{
 *   item: import("../../lib/fileSearch.js").SearchHit,
 *   query: string,
 *   driveLabel: string,
 *   isAdmin: boolean,
 *   memberAccess: any,
 *   index: number,
 *   onNavigate: (feedback?: any) => void,
 *   onShare: (item: any) => void,
 *   onCopy: (kind: "copy" | "move", item: any) => void,
 *   onTrash: (item: any) => void,
 * }} props
 */
export default function FileSearchRow({
  item,
  query,
  driveLabel,
  isAdmin,
  memberAccess,
  index,
  onNavigate,
  onShare,
  onCopy,
  onTrash,
}) {
  const isDir = item.kind === "dir";
  const href = memberAccess ? memberSearchHref(memberAccess, item) : searchResultHref(item);
  // Hits only prove VIEW. Everything else is gated on the member's real
  // caps — share needs the share bit, move/trash need edit.
  const itemCaps = isAdmin
    ? CAP.VIEW | CAP.UPLOAD | CAP.EDIT | CAP.SHARE
    : capsOnPath(memberAccess, item.drive_id, item.path);
  const canShare = (itemCaps & CAP.SHARE) !== 0;
  const canEdit = (itemCaps & CAP.EDIT) !== 0;
  // Openable files open in the viewer on a plain click; the folder icon still
  // jumps to the file's folder.
  const opensInViewer = !isDir && canViewerOpen(item.name);
  const rowHref = opensInViewer
    ? (memberAccess
      ? memberFileHref(memberAccess, item.drive_id, item.path)
      : fileHref(item.drive_id, item.path))
    : href;
  const openLabel = isDir || opensInViewer
    ? `Open ${item.name}`
    : `Show ${item.name} in its folder`;
  const iconOpenLabel = isDir ? `Open ${item.name}` : `Go to folder for ${item.name}`;
  // A near miss wasn't typed exactly, so underlining "the match" would lie.
  const parts = item.match === "close"
    ? [{ text: item.name, hit: false }]
    : highlightParts(item.name, query);

  return (
    <li
      data-slot="file-search-item"
      className="file-search-row-enter"
      style={{ animationDelay: `${Math.min(index, 8) * 28}ms` }}
    >
      <div
        className={cn(
          "relative rounded-large-element surface-primary px-3 py-2",
          "motion-safe:transition-shadow hover:ring-2 hover:ring-accent",
          "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent",
        )}
      >
        {/* Stretched link: row body navigates; action icons sit above it. */}
        <Link
          to={rowHref}
          aria-label={openLabel}
          data-slot="file-search-link"
          className="absolute inset-0 z-0 rounded-large-element no-focus-outline"
          onClick={() => onNavigate("medium")}
        />
        <div className="relative z-10 flex items-center gap-2 min-w-0 pointer-events-none">
          {isDir ? (
            <Folder size={16} className="shrink-0" aria-hidden="true" />
          ) : (
            <FileIcon size={16} className="shrink-0" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-mono text-sm truncate text-secondary">
              {parts.map((part, i) =>
                part.hit ? (
                  <span key={i} className="underline decoration-accent decoration-2 underline-offset-4">
                    {part.text}
                  </span>
                ) : (
                  part.text
                ),
              )}
            </p>
            <p className="text-xs truncate text-secondary">
              {locationLabel(item, driveLabel)}
              {!isDir && item.size != null ? ` · ${fmtSize(item.size)}` : ""}
            </p>
          </div>
          <ActionTooltipGroup>
            <div
              className="flex items-center gap-1 shrink-0 pointer-events-auto"
              onClick={(event) => event.stopPropagation()}
            >
              <Tooltip content={isDir ? "Open" : "Go to folder"}>
                <Button
                  variant="ghost"
                  surface="primary"
                  size="iconSm"
                  asChild
                  aria-label={iconOpenLabel}
                >
                  <Link
                    to={href}
                    onClick={(event) => {
                      event.stopPropagation();
                      onNavigate();
                    }}
                  >
                    <FolderOpen size={14} />
                  </Link>
                </Button>
              </Tooltip>
              <Tooltip content="Download">
                <Button
                  variant="ghost"
                  surface="primary"
                  size="iconSm"
                  asChild
                  aria-label={`Download ${item.name}`}
                >
                  <a href={downloadHref(item.drive_id, item.path)}>
                    <Download size={14} />
                  </a>
                </Button>
              </Tooltip>
              {canShare && (
                <ShareButton
                  label={item.name}
                  surface="primary"
                  onClick={() => onShare(item)}
                />
              )}
              <Tooltip content="Copy">
                <Button
                  variant="ghost"
                  surface="primary"
                  size="iconSm"
                  aria-label={`Copy ${item.name}`}
                  onClick={() => onCopy("copy", item)}
                >
                  <Copy size={14} />
                </Button>
              </Tooltip>
              {canEdit && (
                <>
                  <Tooltip content="Move">
                    <Button
                      variant="ghost"
                      surface="primary"
                      size="iconSm"
                      aria-label={`Move ${item.name}`}
                      onClick={() => onCopy("move", item)}
                    >
                      <FolderInput size={14} />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Move to trash">
                    <Button
                      variant="ghost"
                      surface="primary"
                      size="iconSm"
                      aria-label={`Move ${item.name} to trash`}
                      onClick={() => onTrash(item)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </Tooltip>
                </>
              )}
            </div>
          </ActionTooltipGroup>
        </div>
      </div>
    </li>
  );
}
