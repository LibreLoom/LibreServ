import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  Download,
  File as FileIcon,
  Folder,
  FolderOpen,
} from "lucide-react";
import PropTypes from "prop-types";
import Card from "../cards/Card.jsx";
import Button from "../ui/Button.jsx";
import TextLink from "../ui/TextLink.jsx";
import EmptyState from "../common/EmptyState.jsx";
import { getJson } from "../../lib/api.js";
import {
  downloadHref,
  folderHref as defaultFolderHref,
  fmtSize,
  joinPath,
  parentPath,
} from "../../lib/paths.js";

/**
 * @typedef {{ name: string, kind: "dir"|"file"|string, size?: number, modified?: number, hidden?: boolean }} FileEntry
 * @typedef {{ entry: FileEntry, path: string, fullPath: string }} FileBrowserRowContext
 */

/**
 * Multipurpose file browser for a Luna drive.
 *
 * Used by Drives "Browse files", the Files page listing, and future pickers
 * (copy/move destination, protect, etc.).
 *
 * Navigation is controlled (`path` + `onPathChange`) or uncontrolled
 * (`initialPath`). Pass action callbacks to show copy/move/share/delete;
 * download and open-folder are built in.
 *
 * @param {{
 *   driveId: string,
 *   driveLabel?: string,
 *   initialPath?: string,
 *   path?: string,
 *   onPathChange?: (nextPath: string) => void,
 *   selectionMode?: false | "single" | "folder",
 *   selectedPath?: string | null,
 *   onSelect?: (ctx: FileBrowserRowContext) => void,
 *   onShare?: (ctx: FileBrowserRowContext) => void,
 *   onCopy?: (ctx: FileBrowserRowContext) => void,
 *   onMove?: (ctx: FileBrowserRowContext) => void,
 *   onRename?: (ctx: FileBrowserRowContext) => void,
 *   onDelete?: (ctx: FileBrowserRowContext) => void,
 *   renderRowActions?: (ctx: FileBrowserRowContext) => import("react").ReactNode,
 *   enableDownload?: boolean,
 *   linkNavigation?: boolean,
 *   folderHref?: (driveId: string, folderPath: string) => string,
 *   showBreadcrumbs?: boolean,
 *   showUpButton?: boolean,
 *   breadcrumbExtra?: import("react").ReactNode,
 *   headerExtra?: import("react").ReactNode,
 *   hideHidden?: boolean,
 *   emptyTitle?: string,
 *   emptyIcon?: import("react").ElementType,
 *   className?: string,
 *   listClassName?: string,
 * }} props
 */
export default function FileBrowser({
  driveId,
  driveLabel = "Drive",
  initialPath = "",
  path: controlledPath,
  onPathChange,
  selectionMode = false,
  selectedPath = null,
  onSelect,
  onShare,
  onCopy,
  onMove,
  onRename,
  onDelete,
  renderRowActions,
  enableDownload = true,
  linkNavigation = false,
  folderHref = defaultFolderHref,
  showBreadcrumbs = true,
  showUpButton = true,
  breadcrumbExtra = null,
  headerExtra = null,
  hideHidden = true,
  emptyTitle = "Nothing here yet",
  emptyIcon: EmptyIcon = FolderOpen,
  className = "",
  listClassName = "",
}) {
  const [innerPath, setInnerPath] = useState(initialPath);
  const isControlled = controlledPath !== undefined;
  const path = isControlled ? controlledPath : innerPath;

  function setPath(next) {
    if (!isControlled) setInnerPath(next);
    onPathChange?.(next);
  }

  const listing = useQuery({
    queryKey: ["files", driveId, path],
    queryFn: () =>
      getJson(`/api/v1/drives/${driveId}/files?path=${encodeURIComponent(path)}`),
    enabled: !!driveId,
  });

  const entries = (listing.data || []).filter((e) => !(hideHidden && e.hidden));
  const up = parentPath(path);
  const segments = path.split("/").filter(Boolean);

  function openFolder(folderPath) {
    setPath(folderPath);
  }

  function rowContext(entry) {
    return {
      entry,
      path,
      fullPath: joinPath(path, entry.name),
    };
  }

  function canSelect(entry) {
    if (!selectionMode) return false;
    if (selectionMode === "folder") return entry.kind === "dir";
    return true;
  }

  function defaultActions(ctx) {
    if (renderRowActions) return renderRowActions(ctx);
    const { entry } = ctx;
    const actions = [];
    if (canSelect(entry)) {
      const selected = selectedPath === ctx.fullPath;
      actions.push(
        <Button
          key="select"
          variant={selected ? "primary" : "outline"}
          surface="secondary"
          size="sm"
          aria-label={selected ? `Selected ${entry.name}` : `Select ${entry.name}`}
          aria-pressed={selected}
          onClick={() => onSelect?.(ctx)}
        >
          {selected ? <Check size={14} aria-hidden="true" /> : null}
          {selected ? "Selected" : "Select"}
        </Button>,
      );
    }
    if (onShare) {
      actions.push(
        <Button
          key="share"
          variant="ghost"
          surface="secondary"
          size="sm"
          onClick={() => onShare(ctx)}
        >
          Sharing
        </Button>,
      );
    }
    if (onCopy) {
      actions.push(
        <Button
          key="copy"
          variant="ghost"
          surface="secondary"
          size="iconSm"
          aria-label={`Copy ${entry.name}`}
          onClick={() => onCopy(ctx)}
        >
          Copy
        </Button>,
      );
    }
    if (onMove) {
      actions.push(
        <Button
          key="move"
          variant="ghost"
          surface="secondary"
          size="iconSm"
          aria-label={`Move ${entry.name}`}
          onClick={() => onMove(ctx)}
        >
          Move
        </Button>,
      );
    }
    if (onRename) {
      actions.push(
        <Button
          key="rename"
          variant="ghost"
          surface="secondary"
          size="iconSm"
          aria-label={`Rename ${entry.name}`}
          onClick={() => onRename(ctx)}
        >
          Rename
        </Button>,
      );
    }
    if (onDelete) {
      actions.push(
        <Button
          key="delete"
          variant="ghost"
          surface="secondary"
          size="iconSm"
          aria-label={`Move ${entry.name} to trash`}
          onClick={() => onDelete(ctx)}
        >
          Trash
        </Button>,
      );
    }
    if (enableDownload && entry.kind === "file") {
      actions.push(
        <Button
          key="download"
          variant="ghost"
          surface="secondary"
          size="iconSm"
          asChild
          aria-label={`Download ${entry.name}`}
        >
          <a href={downloadHref(driveId, ctx.fullPath)}>
            <Download size={14} />
          </a>
        </Button>,
      );
    }
    return actions.length ? <div className="flex items-center gap-1 flex-wrap justify-end">{actions}</div> : null;
  }

  return (
    <div className={className} data-slot="file-browser">
      {showBreadcrumbs && (
        <Card className="mb-4" padding>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-primary">
            {linkNavigation ? (
              <TextLink to={folderHref(driveId, "")} surface="secondary">
                {driveLabel}
              </TextLink>
            ) : (
              <button
                type="button"
                className="text-accent hover:text-primary motion-safe:transition-colors"
                onClick={() => openFolder("")}
              >
                {driveLabel}
              </button>
            )}
            {segments.map((segment, i) => {
              const segPath = segments.slice(0, i + 1).join("/");
              return (
                <span key={`${segment}-${i}`} className="flex items-center gap-2">
                  <span className="text-accent" aria-hidden="true">/</span>
                  {linkNavigation ? (
                    <TextLink to={folderHref(driveId, segPath)} surface="secondary">
                      {segment}
                    </TextLink>
                  ) : (
                    <button
                      type="button"
                      className="text-accent hover:text-primary motion-safe:transition-colors"
                      onClick={() => openFolder(segPath)}
                    >
                      {segment}
                    </button>
                  )}
                </span>
              );
            })}
            {breadcrumbExtra}
          </div>
          {(showUpButton && up !== null) || headerExtra ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {showUpButton && up !== null && (
                linkNavigation ? (
                  <Button variant="outline" surface="secondary" size="sm" asChild>
                    <Link to={folderHref(driveId, up)}>↑ Up one folder</Link>
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    surface="secondary"
                    size="sm"
                    onClick={() => openFolder(up)}
                  >
                    ↑ Up one folder
                  </Button>
                )
              )}
              {headerExtra}
            </div>
          ) : null}
        </Card>
      )}

      {listing.isError && (
        <p className="text-error text-sm mb-3" role="alert">
          {String(listing.error?.message || "Luna couldn't open this folder. Try again.")}
        </p>
      )}

      {listing.isLoading && (
        <p className="text-primary text-sm mb-3">Loading files…</p>
      )}

      <div className={`grid gap-3 ${listClassName}`}>
        {entries.map((entry) => {
          const ctx = rowContext(entry);
          const selected = selectionMode && selectedPath === ctx.fullPath;
          const nameClass =
            "flex items-center gap-3 text-left flex-1 min-w-0 text-primary hover:text-accent motion-safe:transition-colors";

          let nameNode;
          if (entry.kind === "dir") {
            if (linkNavigation) {
              nameNode = (
                <Link to={folderHref(driveId, ctx.fullPath)} className={nameClass}>
                  <Folder size={18} className="text-accent shrink-0" aria-hidden="true" />
                  <span className="font-mono text-sm truncate">{entry.name}</span>
                </Link>
              );
            } else {
              nameNode = (
                <button type="button" className={nameClass} onClick={() => openFolder(ctx.fullPath)}>
                  <Folder size={18} className="text-accent shrink-0" aria-hidden="true" />
                  <span className="font-mono text-sm truncate">{entry.name}</span>
                </button>
              );
            }
          } else {
            nameNode = (
              <div className="flex items-center gap-3 text-left flex-1 min-w-0">
                <FileIcon size={18} className="text-accent shrink-0" aria-hidden="true" />
                <span className="text-primary font-mono text-sm truncate">{entry.name}</span>
              </div>
            );
          }

          return (
            <Card
              key={entry.name}
              padding={false}
              noPopIn
              noHeightAnim
              className={selected ? "ring-2 ring-accent" : undefined}
            >
              <div className="flex items-center justify-between p-4 gap-2">
                {nameNode}
                <span className="text-primary text-xs w-20 text-right hidden sm:block">
                  {fmtSize(entry.size)}
                </span>
                {defaultActions(ctx)}
              </div>
            </Card>
          );
        })}
      </div>

      {!listing.isLoading && !listing.isError && entries.length === 0 && (
        <EmptyState className="mt-4" icon={EmptyIcon} title={emptyTitle} />
      )}
    </div>
  );
}

FileBrowser.propTypes = {
  driveId: PropTypes.string.isRequired,
  driveLabel: PropTypes.string,
  initialPath: PropTypes.string,
  path: PropTypes.string,
  onPathChange: PropTypes.func,
  selectionMode: PropTypes.oneOf([false, "single", "folder"]),
  selectedPath: PropTypes.string,
  onSelect: PropTypes.func,
  onShare: PropTypes.func,
  onCopy: PropTypes.func,
  onMove: PropTypes.func,
  onRename: PropTypes.func,
  onDelete: PropTypes.func,
  renderRowActions: PropTypes.func,
  enableDownload: PropTypes.bool,
  linkNavigation: PropTypes.bool,
  folderHref: PropTypes.func,
  showBreadcrumbs: PropTypes.bool,
  showUpButton: PropTypes.bool,
  breadcrumbExtra: PropTypes.node,
  headerExtra: PropTypes.node,
  hideHidden: PropTypes.bool,
  emptyTitle: PropTypes.string,
  emptyIcon: PropTypes.elementType,
  className: PropTypes.string,
  listClassName: PropTypes.string,
};
