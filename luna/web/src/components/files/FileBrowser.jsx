import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
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
import Spinner from "../ui/Spinner.jsx";
import { ActionTooltipGroup, Tooltip } from "../ui/Tooltip.jsx";
import EmptyState from "../common/EmptyState.jsx";
import { getJson } from "../../lib/api.js";
import { filesFromDataTransfer, filesFromFileList } from "../../lib/collectUploadFiles.js";
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
 * Shared file browser for the full files page and folder pickers.
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
 *   trashHref?: string | null,
 *   toolbarExtra?: import("react").ReactNode,
 *   folderActions?: import("react").ReactNode,
 *   hideHidden?: boolean,
 *   emptyTitle?: string,
 *   emptyIcon?: import("react").ElementType,
 *   emptyAction?: import("react").ReactNode,
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
  trashHref = null,
  toolbarExtra = null,
  folderActions = null,
  hideHidden = true,
  emptyTitle = "Nothing here yet",
  emptyIcon: EmptyIcon = FolderOpen,
  emptyAction = null,
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
    // Keep the previous folder visible while the next listing loads so the list
    // card does not collapse empty and pop back in.
    placeholderData: keepPreviousData,
  });

  const listBusy = listing.isLoading || Boolean(listing.isPlaceholderData);
  const showingStaleListing = Boolean(listing.isPlaceholderData);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- props/open seed draft UI state
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
    const files = await filesFromDataTransfer(event.dataTransfer);
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
    const osFiles = await filesFromDataTransfer(event.dataTransfer);
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
        <Tooltip key="copy" content="Copy">
          <Button
            variant="ghost"
            surface="secondary"
            size="iconSm"
            aria-label={`Copy ${ctx.entry.name}`}
            onClick={() => onCopy([ctx.fullPath])}
          >
            <Copy size={14} />
          </Button>
        </Tooltip>,
      );
    }
    if (onMove) {
      actions.push(
        <Tooltip key="move" content="Move">
          <Button
            variant="ghost"
            surface="secondary"
            size="iconSm"
            aria-label={`Move ${ctx.entry.name}`}
            onClick={() => onMove([ctx.fullPath])}
          >
            <FolderInput size={14} />
          </Button>
        </Tooltip>,
      );
    }
    if (onRename) {
      actions.push(
        <Tooltip key="rename" content="Rename">
          <Button
            variant="ghost"
            surface="secondary"
            size="iconSm"
            aria-label={`Rename ${ctx.entry.name}`}
            onClick={() => onRename(ctx)}
          >
            <Pencil size={14} />
          </Button>
        </Tooltip>,
      );
    }
    if (onDelete) {
      actions.push(
        <Tooltip key="delete" content="Move to trash">
          <Button
            variant="ghost"
            surface="secondary"
            size="iconSm"
            aria-label={`Move ${ctx.entry.name} to trash`}
            onClick={() => onDelete([ctx.fullPath])}
          >
            <Trash2 size={14} />
          </Button>
        </Tooltip>,
      );
    }
    if (enableDownload && (ctx.entry.kind === "file" || ctx.entry.kind === "dir")) {
      actions.push(
        <Tooltip key="download" content="Download">
          <Button
            variant="ghost"
            surface="secondary"
            size="iconSm"
            asChild
            aria-label={`Download ${ctx.entry.name}`}
          >
            <a href={downloadHref(driveId, ctx.fullPath)}>
              <Download size={14} />
            </a>
          </Button>
        </Tooltip>,
      );
    }
    return actions.length ? (
      <ActionTooltipGroup>
        <div className="flex items-center gap-0.5 flex-wrap justify-end">{actions}</div>
      </ActionTooltipGroup>
    ) : null;
  }

  const padY = dense ? "py-2" : "py-2.5";
  const allSelected = entryPaths.length > 0 && entryPaths.every((p) => selectedPaths.includes(p));
  const selectedCount = selectedPaths.length;
  const listDropHighlight = Boolean(enableUploadDrop && !isPicker && dragOver && !dropTarget);
  const showTrashEntry = Boolean(trashHref && !isPicker && path === "");

  return (
    <div
      className={className}
      data-slot="file-browser"
      onDragOver={(e) => {
        if (!enableUploadDrop || isPicker) return;
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
        setDropTarget(null);
      }}
      onDragLeave={(e) => {
        // Ignore leave events that stay within this browser (child→child).
        if (e.currentTarget.contains(/** @type {Node|null} */ (e.relatedTarget))) return;
        setDragOver(false);
        setDropTarget(null);
      }}
      onDrop={(e) => {
        if (!enableUploadDrop || isPicker) return;
        void handleOsDrop(e, path);
      }}
    >
      {showBreadcrumbs && (
        <Card className="mb-3" padding>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-mono uppercase tracking-widest text-primary mb-1">
                Current folder
              </p>
              <div
                className="flex flex-wrap items-center gap-2 font-mono text-sm text-primary"
                aria-live="polite"
              >
                {linkNavigation ? (
                  <TextLink to={folderHref(driveId, "")} surface="secondary" className="break-all text-primary">
                    {driveLabel}
                  </TextLink>
                ) : (
                  <button
                    type="button"
                    className="text-primary hover:text-accent motion-safe:transition-colors break-all text-left"
                    onClick={() => openFolder("")}
                  >
                    {driveLabel}
                  </button>
                )}
                {segments.map((segment, i) => {
                  const segPath = segments.slice(0, i + 1).join("/");
                  return (
                    <span key={`${segment}-${i}`} className="flex items-center gap-2 min-w-0">
                      <span className="text-primary" aria-hidden="true">/</span>
                      {linkNavigation ? (
                        <TextLink
                          to={folderHref(driveId, segPath)}
                          surface="secondary"
                          className="break-all text-primary"
                        >
                          {segment}
                        </TextLink>
                      ) : (
                        <button
                          type="button"
                          className="text-primary hover:text-accent motion-safe:transition-colors break-all text-left"
                          onClick={() => openFolder(segPath)}
                        >
                          {segment}
                        </button>
                      )}
                    </span>
                  );
                })}
                {listBusy ? (
                  <Spinner size="sm" label="Loading folder" className="text-primary" />
                ) : null}
                {breadcrumbExtra}
              </div>
            </div>
            {folderActions || (enableUploadDrop && !isPicker) ? (
              <div className="shrink-0 flex flex-wrap items-center justify-end gap-2">
                {folderActions}
                {enableUploadDrop && !isPicker ? (
                  <>
                    <input
                      ref={filePicker}
                      type="file"
                      multiple
                      className="sr-only"
                      onChange={async (e) => {
                        const files = filesFromFileList(e.target.files);
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
                  </>
                ) : null}
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

      {/* Upload / move drop feedback uses the same accent/20 highlight as
          multi-select — no separate dashed banner that jumps layout. */}

      {!isPicker && multiSelect && toolbarExtra && selectedCount === 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {toolbarExtra}
        </div>
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
          {String(
            listing.error?.message?.toLowerCase().includes("drive") ||
            (listing.error && "status" in listing.error && listing.error.status === 404)
              ? "Luna can't find this drive. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in."
              : (listing.error?.message || "Luna couldn't open this folder. Try again.")
          )}
        </p>
      )}

      <Card
        padding={false}
        className={[listClassName, listDropHighlight ? "bg-accent/20" : ""].filter(Boolean).join(" ")}
        aria-busy={listBusy || undefined}
      >
        {listDropHighlight ? (
          <span className="sr-only" role="status">
            Drop to upload into this folder
          </span>
        ) : null}
        {!isPicker && multiSelect && entries.length > 0 && (
          <div
            className={`h-11 flex items-center gap-3 px-3 border-b border-primary/20 ${
              selectedCount > 0 || listDropHighlight ? "bg-accent/20" : ""
            }`}
            role={selectedCount > 0 ? "toolbar" : undefined}
            aria-label={selectedCount > 0 ? "Actions for selected files" : undefined}
          >
            <AnimatedCheckbox
              checked={allSelected}
              onChange={(next) => (next ? selectAllVisible() : clearSelection())}
              aria-label="Select all in this folder"
              surface="secondary"
            />
            {selectedCount > 0 ? (
              <div className="flex flex-nowrap items-center gap-2 flex-1 min-w-0 overflow-x-auto">
                <span className="font-mono text-xs text-primary shrink-0 whitespace-nowrap">
                  {selectedCount} selected
                </span>
                <Button variant="outline" surface="secondary" size="sm" className="shrink-0" onClick={clearSelection}>
                  Clear
                </Button>
                {selectedCount === 1 && onShare ? (
                  <Button
                    variant="outline"
                    surface="secondary"
                    size="sm"
                    className="shrink-0"
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
                {selectedCount === 1 && enableDownload ? (
                  <Button
                    variant="outline"
                    surface="secondary"
                    size="sm"
                    className="shrink-0"
                    asChild
                  >
                    <a href={downloadHref(driveId, selectedPaths[0])}>Download</a>
                  </Button>
                ) : null}
                {onCopy ? (
                  <Button
                    variant="outline"
                    surface="secondary"
                    size="sm"
                    className="shrink-0"
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
                    className="shrink-0"
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
                    className="shrink-0"
                    onClick={() => onDelete(selectedPaths)}
                  >
                    Trash
                  </Button>
                ) : null}
                {toolbarExtra}
              </div>
            ) : (
              <>
                <span className="font-mono text-xs text-primary">Name</span>
                <span className="ml-auto font-mono text-xs text-primary hidden sm:block w-20 text-right">
                  Size
                </span>
                <span className="w-28 shrink-0" aria-hidden="true" />
              </>
            )}
          </div>
        )}

        {listBusy && entries.length === 0 ? (
          <div className="h-11" aria-hidden="true" />
        ) : (
          <ul
            className={["m-0 p-0 list-none", showingStaleListing ? "pointer-events-none" : ""]
              .filter(Boolean)
              .join(" ")}
            aria-label="Files and folders"
            {...(showingStaleListing ? { inert: true } : {})}
          >
            {showTrashEntry ? (
              <li
                className={[
                  "flex items-center gap-2 px-3",
                  padY,
                  "bg-secondary text-primary",
                  "border-b border-primary/15",
                  "motion-safe:transition-colors",
                ].join(" ")}
              >
                {!isPicker && multiSelect ? (
                  <span className="w-5 shrink-0" aria-hidden="true" />
                ) : null}
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {linkNavigation ? (
                    <Link
                      to={trashHref}
                      className="flex items-center gap-2 min-w-0 text-primary hover:underline"
                    >
                      <Trash2 size={16} className="text-accent shrink-0" aria-hidden="true" />
                      <span className="font-mono text-sm truncate">Trash</span>
                    </Link>
                  ) : (
                    <a
                      href={trashHref}
                      className="flex items-center gap-2 min-w-0 text-primary hover:underline"
                    >
                      <Trash2 size={16} className="text-accent shrink-0" aria-hidden="true" />
                      <span className="font-mono text-sm truncate">Trash</span>
                    </a>
                  )}
                </div>
                <span className="text-xs w-20 text-right hidden sm:block shrink-0 text-primary" aria-hidden="true" />
                <div className="shrink-0 w-28" aria-hidden="true" />
              </li>
            ) : null}
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
                    isSelected || isDrop || listDropHighlight ? "bg-accent/20" : "",
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
                    setDragOver(false);
                  }}
                  onDragLeave={(e) => {
                    if (e.currentTarget.contains(/** @type {Node|null} */ (e.relatedTarget))) return;
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
                          className="flex items-center gap-2 min-w-0 text-primary hover:underline"
                        >
                          <Folder size={16} className="text-accent shrink-0" aria-hidden="true" />
                          <span className="font-mono text-sm truncate">{entry.name}</span>
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className="flex items-center gap-2 min-w-0 text-left text-primary hover:underline"
                          onClick={() => openEntry(ctx)}
                        >
                          <Folder size={16} className="text-accent shrink-0" aria-hidden="true" />
                          <span className="font-mono text-sm truncate">{entry.name}</span>
                        </button>
                      )
                    ) : openable ? (
                      <button
                        type="button"
                        className="flex items-center gap-2 min-w-0 text-left text-primary hover:underline"
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
        )}
      </Card>

      {!listBusy && !listing.isError && entries.length === 0 && !showTrashEntry && (
        <EmptyState className="mt-4" icon={EmptyIcon} title={emptyTitle} action={emptyAction} />
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
  trashHref: PropTypes.string,
  toolbarExtra: PropTypes.node,
  folderActions: PropTypes.node,
  hideHidden: PropTypes.bool,
  emptyTitle: PropTypes.string,
  emptyIcon: PropTypes.elementType,
  emptyAction: PropTypes.node,
  className: PropTypes.string,
  listClassName: PropTypes.string,
  dense: PropTypes.bool,
};
