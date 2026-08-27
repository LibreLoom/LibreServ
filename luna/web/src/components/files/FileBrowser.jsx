import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Download,
  File as FileIcon,
  Folder,
  FolderInput,
  FolderOpen,
  Pencil,
  Trash2,
  UploadCloud,
} from "lucide-react";
import PropTypes from "prop-types";
import Card from "../cards/Card.jsx";
import Button from "../ui/Button.jsx";
import TextLink from "../ui/TextLink.jsx";
import AnimatedCheckbox from "../ui/AnimatedCheckbox.jsx";
import EmptyState from "../common/EmptyState.jsx";
import { getJson } from "../../lib/api.js";
import { openableKind } from "../../lib/fileKinds.js";
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
 * Shared file browser for browse modal, full files page, and folder pickers.
 *
 * Browse mode: flat list rows, multi-select, drag-and-drop upload, open files,
 * and the same action set everywhere. Picker mode replaces typed folder paths.
 *
 * @param {{
 *   driveId: string,
 *   driveLabel?: string,
 *   initialPath?: string,
 *   path?: string,
 *   onPathChange?: (nextPath: string) => void,
 *   pickerMode?: false | "folder" | "file" | "any",
 *   selectedPath?: string | null,
 *   onSelect?: (ctx: FileBrowserRowContext) => void,
 *   multiSelect?: boolean,
 *   selectedPaths?: string[],
 *   onSelectedPathsChange?: (paths: string[]) => void,
 *   onShare?: (ctx: FileBrowserRowContext) => void,
 *   onCopy?: (paths: string[]) => void,
 *   onMove?: (paths: string[]) => void,
 *   onRename?: (ctx: FileBrowserRowContext) => void,
 *   onDelete?: (paths: string[]) => void,
 *   onOpenFile?: (ctx: FileBrowserRowContext) => void,
 *   onUploadFiles?: (files: File[], destPath: string) => void | Promise<void>,
 *   onInternalMove?: (paths: string[], destFolder: string) => void | Promise<void>,
 *   renderRowActions?: (ctx: FileBrowserRowContext) => import("react").ReactNode,
 *   enableDownload?: boolean,
 *   enableUploadDrop?: boolean,
 *   linkNavigation?: boolean,
 *   folderHref?: (driveId: string, folderPath: string) => string,
 *   showBreadcrumbs?: boolean,
 *   showUpButton?: boolean,
 *   breadcrumbExtra?: import("react").ReactNode,
 *   headerExtra?: import("react").ReactNode,
 *   toolbarExtra?: import("react").ReactNode,
 *   hideHidden?: boolean,
 *   emptyTitle?: string,
 *   emptyIcon?: import("react").ElementType,
 *   className?: string,
 *   listClassName?: string,
 *   dense?: boolean,
 * }} props
 */
export default function FileBrowser({
  driveId,
  driveLabel = "Drive",
  initialPath = "",
  path: controlledPath,
  onPathChange,
  pickerMode = false,
  selectedPath = null,
  onSelect,
  multiSelect: multiSelectProp,
  selectedPaths: controlledSelected,
  onSelectedPathsChange,
  onShare,
  onCopy,
  onMove,
  onRename,
  onDelete,
  onOpenFile,
  onUploadFiles,
  onInternalMove,
  renderRowActions,
  enableDownload = true,
  enableUploadDrop = false,
  linkNavigation = false,
  folderHref = defaultFolderHref,
  showBreadcrumbs = true,
  showUpButton = true,
  breadcrumbExtra = null,
  headerExtra = null,
  toolbarExtra = null,
  hideHidden = true,
  emptyTitle = "Nothing here yet",
  emptyIcon: EmptyIcon = FolderOpen,
  className = "",
  listClassName = "",
  dense = false,
}) {
  const [innerPath, setInnerPath] = useState(initialPath);
  const [innerSelected, setInnerSelected] = useState(/** @type {string[]} */ ([]));
  const [dragOver, setDragOver] = useState(false);
  const [dropTarget, setDropTarget] = useState(/** @type {string|null} */ (null));
  const [lastClicked, setLastClicked] = useState(/** @type {string|null} */ (null));
  const dragPathsRef = useRef(/** @type {string[]} */ ([]));
  const filePicker = useRef(/** @type {HTMLInputElement|null} */ (null));

  const isControlled = controlledPath !== undefined;
  const path = isControlled ? controlledPath : innerPath;
  const isPicker = Boolean(pickerMode);
  const multiSelect = multiSelectProp ?? (!isPicker);

  const selectedPaths = controlledSelected !== undefined ? controlledSelected : innerSelected;

  function setSelectedPaths(next) {
    if (controlledSelected === undefined) setInnerSelected(next);
    onSelectedPathsChange?.(next);
  }

  function setPath(next) {
    if (!isControlled) setInnerPath(next);
    onPathChange?.(next);
    setSelectedPaths([]);
    setLastClicked(null);
  }

  const listing = useQuery({
    queryKey: ["files", driveId, path],
    queryFn: () =>
      getJson(`/api/v1/drives/${driveId}/files?path=${encodeURIComponent(path)}`),
    enabled: !!driveId,
  });

  const entries = useMemo(
    () => (listing.data || []).filter((e) => !(hideHidden && e.hidden)),
    [listing.data, hideHidden],
  );

  const entryPaths = useMemo(
    () => entries.map((e) => joinPath(path, e.name)),
    [entries, path],
  );

  useEffect(() => {
    if (controlledSelected !== undefined) return;
    setInnerSelected((prev) => prev.filter((p) => {
      const parent = parentPath(p);
      if (parent === path || (parent === "" && path === "")) {
        return entryPaths.includes(p);
      }
      // Keep selection that lives outside this folder (bulk ops across nav).
      return parent !== path;
    }));
  }, [entryPaths, path, controlledSelected]);

  const up = parentPath(path);
  const segments = path.split("/").filter(Boolean);
  const pathLabel = path ? `${driveLabel} / ${segments.join(" / ")}` : driveLabel;

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

  function canPick(entry) {
    if (!pickerMode) return false;
    if (pickerMode === "folder") return entry.kind === "dir";
    if (pickerMode === "file") return entry.kind === "file";
    return true;
  }

  function toggleOne(fullPath, { additive = false, range = false } = {}) {
    if (!multiSelect) {
      setSelectedPaths(selectedPaths[0] === fullPath ? [] : [fullPath]);
      setLastClicked(fullPath);
      return;
    }
    if (range && lastClicked && entryPaths.includes(lastClicked)) {
      const a = entryPaths.indexOf(lastClicked);
      const b = entryPaths.indexOf(fullPath);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const slice = entryPaths.slice(lo, hi + 1);
        const merged = new Set(additive ? selectedPaths : []);
        slice.forEach((p) => merged.add(p));
        setSelectedPaths([...merged]);
        setLastClicked(fullPath);
        return;
      }
    }
    if (additive) {
      setSelectedPaths(
        selectedPaths.includes(fullPath)
          ? selectedPaths.filter((p) => p !== fullPath)
          : [...selectedPaths, fullPath],
      );
    } else {
      setSelectedPaths(selectedPaths.includes(fullPath) && selectedPaths.length === 1 ? [] : [fullPath]);
    }
    setLastClicked(fullPath);
  }

  function selectAllVisible() {
    setSelectedPaths(entryPaths);
  }

  function clearSelection() {
    setSelectedPaths([]);
    setLastClicked(null);
  }

  function openEntry(ctx) {
    if (ctx.entry.kind === "dir") {
      openFolder(ctx.fullPath);
      return;
    }
    if (onOpenFile && openableKind(ctx.entry.name)) {
      onOpenFile(ctx);
    }
  }

  async function handleOsDrop(event, destPath) {
    event.preventDefault();
    setDragOver(false);
    setDropTarget(null);
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length && onUploadFiles) {
      await onUploadFiles(files, destPath);
    }
  }

  function onRowDragStart(ctx, event) {
    if (isPicker || !onInternalMove) return;
    const paths = selectedPaths.includes(ctx.fullPath) && selectedPaths.length
      ? selectedPaths
      : [ctx.fullPath];
    dragPathsRef.current = paths;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-luna-paths", JSON.stringify(paths));
    event.dataTransfer.setData("text/plain", paths.join("\n"));
  }

  async function onFolderDrop(destFolder, event) {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    const osFiles = Array.from(event.dataTransfer?.files || []);
    if (osFiles.length && onUploadFiles) {
      await onUploadFiles(osFiles, destFolder);
      return;
    }
    if (!onInternalMove) return;
    let paths = dragPathsRef.current;
    const raw = event.dataTransfer?.getData("application/x-luna-paths");
    if (raw) {
      try {
        paths = JSON.parse(raw);
      } catch {
        // keep ref
      }
    }
    const filtered = (paths || []).filter((p) => p && p !== destFolder && !destFolder.startsWith(`${p}/`));
    if (filtered.length) await onInternalMove(filtered, destFolder);
    dragPathsRef.current = [];
  }

  function rowActions(ctx) {
    if (renderRowActions) return renderRowActions(ctx);
    if (isPicker) {
      if (!canPick(ctx.entry)) return null;
      const selected = selectedPath === ctx.fullPath;
      return (
        <Button
          variant={selected ? "primary" : "outline"}
          surface="secondary"
          size="sm"
          aria-label={selected ? `Selected ${ctx.entry.name}` : `Select ${ctx.entry.name}`}
          aria-pressed={selected}
          onClick={() => onSelect?.(ctx)}
        >
          {selected ? <Check size={14} aria-hidden="true" /> : null}
          {selected ? "Selected" : "Select"}
        </Button>
      );
    }

    const actions = [];
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
          aria-label={`Copy ${ctx.entry.name}`}
          onClick={() => onCopy([ctx.fullPath])}
        >
          <Copy size={14} />
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
          aria-label={`Move ${ctx.entry.name}`}
          onClick={() => onMove([ctx.fullPath])}
        >
          <FolderInput size={14} />
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
          aria-label={`Rename ${ctx.entry.name}`}
          onClick={() => onRename(ctx)}
        >
          <Pencil size={14} />
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
          aria-label={`Move ${ctx.entry.name} to trash`}
          onClick={() => onDelete([ctx.fullPath])}
        >
          <Trash2 size={14} />
        </Button>,
      );
    }
    if (enableDownload && ctx.entry.kind === "file") {
      actions.push(
        <Button
          key="download"
          variant="ghost"
          surface="secondary"
          size="iconSm"
          asChild
          aria-label={`Download ${ctx.entry.name}`}
        >
          <a href={downloadHref(driveId, ctx.fullPath)}>
            <Download size={14} />
          </a>
        </Button>,
      );
    }
    return actions.length ? (
      <div className="flex items-center gap-0.5 flex-wrap justify-end">{actions}</div>
    ) : null;
  }

  const padY = dense ? "py-2" : "py-2.5";
  const allSelected = entryPaths.length > 0 && entryPaths.every((p) => selectedPaths.includes(p));
  const selectedCount = selectedPaths.length;

  return (
    <div
      className={className}
      data-slot="file-browser"
      onDragOver={(e) => {
        if (!enableUploadDrop || isPicker) return;
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!enableUploadDrop || isPicker) return;
        void handleOsDrop(e, path);
      }}
    >
      {showBreadcrumbs && (
        <Card className="mb-3" padding>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-mono uppercase tracking-widest text-accent mb-1">
                Current folder
              </p>
              <p className="font-mono text-sm text-primary break-all" aria-live="polite">
                {pathLabel}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs text-primary">
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
            </div>
            {enableUploadDrop && !isPicker ? (
              <div className="shrink-0">
                <input
                  ref={filePicker}
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={async (e) => {
                    const files = [...(e.target.files || [])];
                    e.target.value = "";
                    if (files.length && onUploadFiles) await onUploadFiles(files, path);
                  }}
                />
                <Button
                  variant="outline"
                  surface="secondary"
                  size="sm"
                  type="button"
                  onClick={() => filePicker.current?.click()}
                >
                  <UploadCloud size={14} aria-hidden="true" />
                  Upload
                </Button>
              </div>
            ) : null}
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

      {enableUploadDrop && !isPicker && dragOver && (
        <div
          className="mb-3 rounded-large-element border-2 border-dashed border-accent bg-secondary text-primary px-4 py-6 text-center"
          role="status"
        >
          <UploadCloud size={20} className="text-accent mx-auto mb-2" aria-hidden="true" />
          <p className="text-sm">Drop to upload into this folder</p>
        </div>
      )}

      {!isPicker && multiSelect && (selectedCount > 0 || toolbarExtra) && (
        <Card className="mb-3" padding>
          <div className="flex flex-wrap items-center gap-2">
            {selectedCount > 0 ? (
              <>
                <span className="font-mono text-xs text-primary">
                  {selectedCount} selected
                </span>
                <Button variant="outline" surface="secondary" size="sm" onClick={clearSelection}>
                  Clear
                </Button>
                {selectedCount === 1 && onShare ? (
                  <Button
                    variant="outline"
                    surface="secondary"
                    size="sm"
                    onClick={() => {
                      const fullPath = selectedPaths[0];
                      const name = fullPath.split("/").pop() || fullPath;
                      const entry = entries.find((e) => joinPath(path, e.name) === fullPath)
                        || { name, kind: "file" };
                      onShare({ entry, path, fullPath });
                    }}
                  >
                    Sharing
                  </Button>
                ) : null}
                {onCopy ? (
                  <Button
                    variant="outline"
                    surface="secondary"
                    size="sm"
                    onClick={() => onCopy(selectedPaths)}
                  >
                    Copy
                  </Button>
                ) : null}
                {onMove ? (
                  <Button
                    variant="outline"
                    surface="secondary"
                    size="sm"
                    onClick={() => onMove(selectedPaths)}
                  >
                    Move
                  </Button>
                ) : null}
                {onDelete ? (
                  <Button
                    variant="outline"
                    surface="secondary"
                    size="sm"
                    onClick={() => onDelete(selectedPaths)}
                  >
                    Trash
                  </Button>
                ) : null}
              </>
            ) : null}
            {toolbarExtra}
          </div>
        </Card>
      )}

      {isPicker && pickerMode === "folder" && (
        <Card className="mb-3" padding>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-primary text-sm flex-1 min-w-0">
              Choose a folder, or use the one you are in now.
            </p>
            <Button
              variant={selectedPath === path ? "primary" : "accent"}
              surface="secondary"
              size="sm"
              onClick={() => onSelect?.({
                entry: { name: pathBasenameSafe(path) || driveLabel, kind: "dir" },
                path: parentPath(path) || "",
                fullPath: path,
              })}
            >
              {selectedPath === path ? "Using this folder" : "Use this folder"}
            </Button>
          </div>
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

      <Card padding={false} noPopIn noHeightAnim className={`overflow-hidden ${listClassName}`.trim()}>
        {!isPicker && multiSelect && entries.length > 0 && (
          <div className={`flex items-center gap-3 px-3 ${padY} border-b border-primary/20`}>
            <AnimatedCheckbox
              checked={allSelected}
              onChange={(next) => (next ? selectAllVisible() : clearSelection())}
              aria-label="Select all in this folder"
              surface="secondary"
            />
            <span className="font-mono text-xs text-primary">Name</span>
            <span className="ml-auto font-mono text-xs text-primary hidden sm:block w-20 text-right">
              Size
            </span>
            <span className="w-28 shrink-0" aria-hidden="true" />
          </div>
        )}

        <ul className="m-0 p-0 list-none" aria-label="Files and folders">
          {entries.map((entry) => {
            const ctx = rowContext(entry);
            const isSelected = selectedPaths.includes(ctx.fullPath);
            const isDrop = dropTarget === ctx.fullPath;
            const openable = entry.kind === "file" && openableKind(entry.name);

            return (
              <li
                key={entry.name}
                className={[
                  "flex items-center gap-2 px-3",
                  padY,
                  "bg-secondary text-primary",
                  isSelected ? "ring-2 ring-inset ring-accent" : "",
                  isDrop ? "outline outline-2 outline-accent" : "",
                  "border-b border-primary/15 last:border-b-0",
                  "motion-safe:transition-colors",
                ].filter(Boolean).join(" ")}
                draggable={!isPicker && Boolean(onInternalMove)}
                onDragStart={(e) => onRowDragStart(ctx, e)}
                onDragOver={(e) => {
                  if (entry.kind !== "dir") return;
                  if (!onInternalMove && !onUploadFiles) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(ctx.fullPath);
                }}
                onDragLeave={() => {
                  if (dropTarget === ctx.fullPath) setDropTarget(null);
                }}
                onDrop={(e) => {
                  if (entry.kind !== "dir") return;
                  void onFolderDrop(ctx.fullPath, e);
                }}
              >
                {!isPicker && multiSelect ? (
                  <AnimatedCheckbox
                    checked={isSelected}
                    onChange={(next, e) => {
                      const shift = Boolean(
                        /** @type {MouseEvent|undefined} */ (e?.nativeEvent)?.shiftKey,
                      );
                      if (shift) {
                        toggleOne(ctx.fullPath, { additive: true, range: true });
                        return;
                      }
                      setSelectedPaths(
                        next
                          ? [...new Set([...selectedPaths, ctx.fullPath])]
                          : selectedPaths.filter((p) => p !== ctx.fullPath),
                      );
                      setLastClicked(ctx.fullPath);
                    }}
                    aria-label={`Select ${entry.name}`}
                    surface="secondary"
                  />
                ) : null}

                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {entry.kind === "dir" ? (
                    linkNavigation ? (
                      <Link
                        to={folderHref(driveId, ctx.fullPath)}
                        className="flex items-center gap-2 min-w-0 text-primary hover:text-accent"
                      >
                        <Folder size={16} className="text-accent shrink-0" aria-hidden="true" />
                        <span className="font-mono text-sm truncate">{entry.name}</span>
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="flex items-center gap-2 min-w-0 text-left text-primary hover:text-accent"
                        onClick={() => openEntry(ctx)}
                      >
                        <Folder size={16} className="text-accent shrink-0" aria-hidden="true" />
                        <span className="font-mono text-sm truncate">{entry.name}</span>
                      </button>
                    )
                  ) : openable ? (
                    <button
                      type="button"
                      className="flex items-center gap-2 min-w-0 text-left text-primary hover:text-accent"
                      onClick={() => openEntry(ctx)}
                    >
                      <FileIcon size={16} className="text-accent shrink-0" aria-hidden="true" />
                      <span className="font-mono text-sm truncate">{entry.name}</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 min-w-0 text-primary">
                      <FileIcon size={16} className="text-accent shrink-0" aria-hidden="true" />
                      <span className="font-mono text-sm truncate">{entry.name}</span>
                    </div>
                  )}
                </div>

                <span className="text-xs w-20 text-right hidden sm:block shrink-0 text-primary">
                  {fmtSize(entry.size)}
                </span>

                <div className="shrink-0 max-w-[40%] sm:max-w-none">
                  {rowActions(ctx)}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {!listing.isLoading && !listing.isError && entries.length === 0 && (
        <EmptyState className="mt-4" icon={EmptyIcon} title={emptyTitle} />
      )}
    </div>
  );
}

function pathBasenameSafe(path) {
  if (!path) return "";
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

FileBrowser.propTypes = {
  driveId: PropTypes.string.isRequired,
  driveLabel: PropTypes.string,
  initialPath: PropTypes.string,
  path: PropTypes.string,
  onPathChange: PropTypes.func,
  pickerMode: PropTypes.oneOf([false, "folder", "file", "any"]),
  selectedPath: PropTypes.string,
  onSelect: PropTypes.func,
  multiSelect: PropTypes.bool,
  selectedPaths: PropTypes.arrayOf(PropTypes.string),
  onSelectedPathsChange: PropTypes.func,
  onShare: PropTypes.func,
  onCopy: PropTypes.func,
  onMove: PropTypes.func,
  onRename: PropTypes.func,
  onDelete: PropTypes.func,
  onOpenFile: PropTypes.func,
  onUploadFiles: PropTypes.func,
  onInternalMove: PropTypes.func,
  renderRowActions: PropTypes.func,
  enableDownload: PropTypes.bool,
  enableUploadDrop: PropTypes.bool,
  linkNavigation: PropTypes.bool,
  folderHref: PropTypes.func,
  showBreadcrumbs: PropTypes.bool,
  showUpButton: PropTypes.bool,
  breadcrumbExtra: PropTypes.node,
  headerExtra: PropTypes.node,
  toolbarExtra: PropTypes.node,
  hideHidden: PropTypes.bool,
  emptyTitle: PropTypes.string,
  emptyIcon: PropTypes.elementType,
  className: PropTypes.string,
  listClassName: PropTypes.string,
  dense: PropTypes.bool,
};
