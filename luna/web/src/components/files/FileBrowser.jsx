import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
  Search,
  SearchX,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import PropTypes from "prop-types";
import { cn } from "@libreloom/ui/lib/utils.js";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import TextLink from "../ui/TextLink.jsx";
import AnimatedCheckbox from "@libreloom/ui/components/ui/AnimatedCheckbox.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { ActionTooltipGroup, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { fileListKey, useFileSource } from "../../lib/fileSource.jsx";
import { CAP } from "../../lib/access.js";

const UNPLUGGED_DRIVE_MESSAGE =
  "Luna can't find this drive. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in.";

/** Listing failed because the on-drive database is gone, not because the drive left. */
function isMissingDriveDb(error) {
  if (!error) return false;
  if ("code" in error && error.code === "missing_drive_db") return true;
  return String(error.message || "")
    .toLowerCase()
    .includes("database for this drive is missing");
}

function folderListingError(error) {
  const message = String(error?.message || "");
  if (isMissingDriveDb(error)) {
    return (
      message ||
      "Luna's database for this drive is missing. The drive is still plugged in. On the Drives page, remove this drive, then add it again."
    );
  }
  const unplugged =
    message.toLowerCase().includes("drive") ||
    (error && "status" in error && error.status === 404);
  if (unplugged) return UNPLUGGED_DRIVE_MESSAGE;
  return message || "Luna couldn't open this folder. Try again.";
}
import { filesFromDataTransfer, filesFromFileList } from "../../lib/collectUploadFiles.js";
import {
  LUNA_DRIVE_MIME,
  LUNA_PATHS_MIME,
  SPRING_LOAD_MS,
  hasLunaPaths,
  hasOsFiles,
  readLunaDrive,
  readLunaPaths,
} from "../../lib/dnd.js";
import { canViewerOpen } from "../../lib/officeConvert.js";
import { isFormFile, viewerNeedsSession } from "../../lib/fileKinds.js";
import FormResponseBadge from "./forms/FormResponseBadge.jsx";
import PropertiesSheet, { PropertiesButton } from "./PropertiesSheet.jsx";
import {
  fileHref as defaultFileHref,
  folderHref as defaultFolderHref,
  isTrashPath,
  joinPath,
  parentPath,
} from "../../lib/paths.js";

/** Card `p-5` on each side — folder chrome must fit inside the padded area. */
const FOLDER_CARD_PAD_X = 40;
/** `gap-3` between path and New/Upload in the combined row. */
const FOLDER_ROW_GAP = 12;
/** Extra room required before collapsing a split back to one card (anti-flicker). */
const FOLDER_UNSPLIT_SLACK = 24;

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** CSS.escape polyfill for attribute selectors. */
function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const SORT_OPTIONS = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "date-desc", label: "Newest first" },
  { value: "date-asc", label: "Oldest first" },
  { value: "size-desc", label: "Largest first" },
  { value: "size-asc", label: "Smallest first" },
  { value: "kind", label: "File type" },
];
const SORT_VALUES = new Set(SORT_OPTIONS.map((option) => option.value));
const SORT_STORAGE_KEY = "luna.files.sort";
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function readStoredSort() {
  try {
    const saved = window.localStorage.getItem(SORT_STORAGE_KEY);
    return saved && SORT_VALUES.has(saved) ? saved : "name-asc";
  } catch {
    return "name-asc";
  }
}

function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** What the user sees for this row — trash entries carry `original_name`. */
function displayNameOf(entry) {
  return entry?.original_name || entry?.name || "";
}

/** Folders always lead; the chosen key orders within each group. */
function compareEntries(a, b, sortKey) {
  const aDir = a.kind === "dir" ? 0 : 1;
  const bDir = b.kind === "dir" ? 0 : 1;
  if (aDir !== bDir) return aDir - bDir;
  const byName = NAME_COLLATOR.compare(displayNameOf(a), displayNameOf(b));
  switch (sortKey) {
    case "name-desc":
      return NAME_COLLATOR.compare(displayNameOf(b), displayNameOf(a));
    case "date-desc":
      return (Number(b.modified) || 0) - (Number(a.modified) || 0) || byName;
    case "date-asc":
      return (Number(a.modified) || 0) - (Number(b.modified) || 0) || byName;
    case "size-desc":
      return (Number(b.size) || 0) - (Number(a.size) || 0) || byName;
    case "size-asc":
      return (Number(a.size) || 0) - (Number(b.size) || 0) || byName;
    case "kind": {
      const byExtension = NAME_COLLATOR.compare(
        extensionOf(displayNameOf(a)),
        extensionOf(displayNameOf(b)),
      );
      return byExtension || byName;
    }
    default:
      return byName;
  }
}

/**
 * @typedef {{ name: string, kind: "dir"|"file"|string, size?: number, modified?: number, hidden?: boolean, saving?: boolean, original_name?: string, original_path?: string }} FileEntry
 * @typedef {{ entry: FileEntry, path: string, fullPath: string, displayName: string }} FileBrowserRowContext
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
 *   selectPath?: string | null,
 *   onSelectPathApplied?: () => void,
 *   onShare?: (ctx: FileBrowserRowContext) => void,
 *   onCopy?: (paths: string[]) => void,
 *   onMove?: (paths: string[]) => void,
 *   onRename?: (ctx: FileBrowserRowContext) => void,
 *   onDelete?: (paths: string[]) => void,
 *   onOpenFile?: (ctx: FileBrowserRowContext) => void,
 *   onUploadFiles?: (files: File[], destPath: string) => void | Promise<void>,
 *   onInternalMove?: (paths: string[], destFolder: string, destDriveId?: string, sourceDriveId?: string) => void | Promise<void>,
 *   renderRowActions?: (ctx: FileBrowserRowContext) => import("react").ReactNode,
 *   renderSelectionActions?: (paths: string[], rows: FileBrowserRowContext[]) => import("react").ReactNode,
 *   enableDownload?: boolean,
 *   enableUploadDrop?: boolean,
 *   linkNavigation?: boolean,
 *   folderHref?: (driveId: string, folderPath: string) => string,
 *   fileHref?: (driveId: string, filePath: string) => string,
 *   showBreadcrumbs?: boolean,
 *   showUpButton?: boolean,
 *   segmentLabel?: (segment: string, index: number) => string,
 *   breadcrumbExtra?: import("react").ReactNode,
 *   headerExtra?: import("react").ReactNode,
 *   trashHref?: string | null,
 *   toolbarExtra?: import("react").ReactNode,
 *   folderActions?: import("react").ReactNode,
 *   hideHidden?: boolean,
 *   emptyTitle?: string,
 *   emptyIcon?: import("react").ElementType,
 *   emptyDescription?: string,
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
  selectPath = null,
  onSelectPathApplied,
  onShare,
  onCopy,
  onMove,
  onRename,
  onDelete,
  onOpenFile,
  onUploadFiles,
  onInternalMove,
  renderRowActions,
  renderSelectionActions,
  enableDownload = true,
  enableUploadDrop = false,
  linkNavigation = false,
  folderHref = defaultFolderHref,
  fileHref = defaultFileHref,
  showBreadcrumbs = true,
  showUpButton = true,
  segmentLabel = null,
  breadcrumbExtra = null,
  headerExtra = null,
  trashHref = null,
  toolbarExtra = null,
  folderActions = null,
  hideHidden = true,
  emptyTitle = "Nothing here yet",
  emptyIcon: EmptyIcon = FolderOpen,
  emptyAction = null,
  emptyDescription = "",
  className = "",
  listClassName = "",
  dense = false,
}) {
  const [innerPath, setInnerPath] = useState(initialPath);
  const [innerSelected, setInnerSelected] = useState(/** @type {string[]} */ ([]));
  // True while an internal (application/x-luna-paths) drag is in flight —
  // drives the "Move into this folder" chip. Set on row dragstart and on any
  // container dragover carrying the mime (covers drags spring-loaded in from
  // another drive's browser); cleared on drop/dragend/real dragleave.
  const [lunaDragActive, setLunaDragActive] = useState(false);
  const [dropTarget, setDropTarget] = useState(/** @type {string|null} */ (null));
  const [lastClicked, setLastClicked] = useState(/** @type {string|null} */ (null));
  const [propertiesCtx, setPropertiesCtx] = useState(/** @type {FileBrowserRowContext|null} */ (null));
  const dragPathsRef = useRef(/** @type {string[]} */ ([]));
  const springLoadTimerRef = useRef(/** @type {number|null} */ (null));
  const springLoadTargetRef = useRef(/** @type {string|null} */ (null));
  const filePicker = useRef(/** @type {HTMLInputElement|null} */ (null));
  const listRef = useRef(/** @type {HTMLUListElement|null} */ (null));
  const appliedSelectRef = useRef(/** @type {string|null} */ (null));
  const folderChromeRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const folderChromeProbeRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const [measuredFolderChromeSplit, setMeasuredFolderChromeSplit] = useState(false);
  const navigate = useNavigate();
  const source = useFileSource();

  const isControlled = controlledPath !== undefined;
  const path = isControlled ? controlledPath : innerPath;
  const isPicker = Boolean(pickerMode);
  // Trash browses through this same browser — read-only by wiring, so rows
  // keep their pre-trash names and session-backed editors stay closed.
  const trashView = isTrashPath(path);
  const multiSelect = multiSelectProp ?? (!isPicker);
  const hasFolderActions = Boolean(folderActions || (enableUploadDrop && !isPicker));
  const folderChromeSplit = hasFolderActions && showBreadcrumbs && measuredFolderChromeSplit;

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
    queryKey: fileListKey(source, driveId, path),
    queryFn: () => source.listDir(driveId, path),
    enabled: !!driveId,
    // Keep the previous folder visible while the next listing loads so the list
    // card does not collapse empty and pop back in.
    placeholderData: keepPreviousData,
    // Poll while any file is still flushing from RAM to the drive so "Saving…"
    // clears without a manual refresh.
    refetchInterval: (query) =>
      (query.state.data || []).some((e) => e?.saving) ? 750 : false,
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

  const [sortKey, setSortKey] = useState(readStoredSort);
  const [kindFilter, setKindFilter] = useState("all");
  const [filterText, setFilterText] = useState("");

  function changeSort(next) {
    setSortKey(next);
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode) — the sort still applies.
    }
  }

  // Rows after the view controls: kind filter, name filter, then the sort.
  // Folders stay grouped on top for every sort — see compareEntries.
  const visibleEntries = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    return entries
      .filter((e) => (
        (kindFilter === "all" || (kindFilter === "dir" ? e.kind === "dir" : e.kind !== "dir"))
        && (!query || displayNameOf(e).toLowerCase().includes(query))
      ))
      .sort((a, b) => compareEntries(a, b, sortKey));
  }, [entries, kindFilter, filterText, sortKey]);

  const visiblePaths = useMemo(
    () => visibleEntries.map((e) => joinPath(path, e.name)),
    [visibleEntries, path],
  );
  const narrowed = visibleEntries.length !== entries.length;

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

  // Link navigation (and search deep-links) change `path` without calling setPath,
  // so clear the previous folder's selection unless a fresh `select=` is pending.
  const prevPathRef = useRef(path);
  useEffect(() => {
    if (prevPathRef.current === path) return;
    prevPathRef.current = path;
    // A typed name filter does not carry into the next folder.
    setFilterText("");
    if (selectPath) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- path transition clears selection
    setSelectedPaths([]);
    setLastClicked(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- path transition seed only
  }, [path, selectPath]);

  // A deep-linked select= row must be visible: clear the name filter so the
  // row renders before the select effect tries to scroll to it.
  useEffect(() => {
    if (!selectPath) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep-link needs its row visible
    setFilterText("");
  }, [selectPath]);

  // Deep-link from search (`?select=`): select the file once the listing is
  // ready, scroll it into view, then let the parent clear the query param.
  useEffect(() => {
    if (!selectPath) {
      appliedSelectRef.current = null;
      return;
    }
    if (listBusy) return;
    if (appliedSelectRef.current === selectPath) return;
    if (!entryPaths.includes(selectPath)) {
      appliedSelectRef.current = selectPath;
      onSelectPathApplied?.();
      return;
    }
    appliedSelectRef.current = selectPath;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep-link select= seed
    setSelectedPaths([selectPath]);
    setLastClicked(selectPath);
    const frame = window.requestAnimationFrame(() => {
      const root = listRef.current;
      if (!root) return;
      const row = root.querySelector(`[data-file-path="${cssEscape(selectPath)}"]`);
      if (row && typeof row.scrollIntoView === "function") {
        row.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      }
    });
    onSelectPathApplied?.();
    return () => window.cancelAnimationFrame(frame);
    // setSelectedPaths is stable enough for this deep-link seed; listing/selectPath drive re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional seed-once-per-selectPath
  }, [selectPath, entryPaths, listBusy, onSelectPathApplied]);

  const up = parentPath(path);
  const segments = path.split("/").filter(Boolean);

  const remeasureFolderChrome = useCallback(() => {
    const container = folderChromeRef.current;
    const probe = folderChromeProbeRef.current;
    if (!container || !probe || !hasFolderActions || !showBreadcrumbs) {
      return;
    }

    const available = container.clientWidth - FOLDER_CARD_PAD_X;
    if (available <= 0) return;

    const needed = probe.scrollWidth;
    setMeasuredFolderChromeSplit((wasSplit) => {
      if (wasSplit) {
        return needed + FOLDER_UNSPLIT_SLACK > available;
      }
      return needed > available;
    });
  }, [hasFolderActions, showBreadcrumbs]);

  useEffect(() => {
    if (!hasFolderActions || !showBreadcrumbs) {
      return;
    }

    const container = folderChromeRef.current;
    const probe = folderChromeProbeRef.current;
    if (!container) return;

    const timeoutId = window.setTimeout(remeasureFolderChrome, 50);
    /** @type {ResizeObserver | null} */
    let observer = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(remeasureFolderChrome);
      observer.observe(container);
      if (probe) observer.observe(probe);
    }
    window.addEventListener("resize", remeasureFolderChrome);

    return () => {
      window.clearTimeout(timeoutId);
      observer?.disconnect();
      window.removeEventListener("resize", remeasureFolderChrome);
    };
  }, [
    hasFolderActions,
    showBreadcrumbs,
    folderChromeSplit,
    remeasureFolderChrome,
    driveLabel,
    path,
    folderActions,
    enableUploadDrop,
    isPicker,
    breadcrumbExtra,
  ]);

  function openFolder(folderPath, { feedback = true } = {}) {
    if (feedback) haptic("medium");
    setPath(folderPath);
  }

  const clearSpringLoad = useCallback(() => {
    if (springLoadTimerRef.current !== null) {
      window.clearTimeout(springLoadTimerRef.current);
      springLoadTimerRef.current = null;
    }
    springLoadTargetRef.current = null;
  }, []);

  // A pending spring-load must not fire after unmount mid-drag.
  useEffect(() => clearSpringLoad, [clearSpringLoad]);

  /**
   * Spring-load: holding a drag over a folder drop target for
   * SPRING_LOAD_MS navigates into it, so a drag can reach nested
   * destinations. React navigation does not cancel the in-flight HTML5
   * drag — the dataTransfer stays alive and the eventual drop lands
   * wherever the pointer is in the new view.
   */
  function springLoadTo(folderPath) {
    haptic("selection");
    // Clear the source folder's highlight before the view swaps.
    setDropTarget(null);
    if (linkNavigation) {
      // Same href the folder's normal Link click uses — pushes a history
      // entry so forward/back behave identically to a click.
      navigate(folderHref(driveId, folderPath));
      return;
    }
    openFolder(folderPath, { feedback: false });
  }

  /**
   * Arm the spring-load timer for a folder drop target. Repeated dragover
   * events on the same target keep the original timer; after it fires the
   * target stays latched so stale dragovers (placeholder rows linger while
   * the new listing loads) cannot re-fire it.
   */
  function armSpringLoad(folderPath) {
    if (folderPath === path) return;
    if (springLoadTargetRef.current === folderPath) return;
    clearSpringLoad();
    springLoadTargetRef.current = folderPath;
    springLoadTimerRef.current = window.setTimeout(() => {
      springLoadTimerRef.current = null;
      springLoadTo(folderPath);
    }, SPRING_LOAD_MS);
  }

  /** Clear a pending spring-load only if it was armed for this target. */
  function disarmSpringLoad(folderPath) {
    if (springLoadTargetRef.current === folderPath) clearSpringLoad();
  }

  /**
   * Shared drop props for folder destinations — the root crumb, breadcrumb
   * segments, the Up button, and folder rows all behave the same: accept
   * internal moves and OS files, highlight on hover, spring-load on hold,
   * and drop into `destFolder`.
   */
  function folderDropProps(key, destFolder) {
    // Trash rows/crumbs never accept drops — trash is read-only.
    if (isPicker || trashView || (!onInternalMove && !onUploadFiles)) return {};
    return {
      onDragOver: (e) => {
        const isLuna = hasLunaPaths(e);
        const isFiles = hasOsFiles(e);
        if (!isFiles && !isLuna) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = isLuna ? "move" : "copy";
        setDropTarget(key);
        armSpringLoad(destFolder);
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(/** @type {Node|null} */ (e.relatedTarget))) return;
        if (dropTarget === key) setDropTarget(null);
        disarmSpringLoad(destFolder);
      },
      onDrop: (e) => {
        void onFolderDrop(destFolder, e);
      },
    };
  }

  function rowContext(entry) {
    return {
      entry,
      path,
      fullPath: joinPath(path, entry.name),
      displayName: displayNameOf(entry),
    };
  }

  function canPick(entry) {
    if (!pickerMode) return false;
    if (pickerMode === "folder") return entry.kind === "dir";
    if (pickerMode === "file") return entry.kind === "file";
    return true;
  }

  function toggleOne(fullPath, { additive = false, range = false } = {}) {
    haptic("selection");
    if (!multiSelect) {
      setSelectedPaths(selectedPaths[0] === fullPath ? [] : [fullPath]);
      setLastClicked(fullPath);
      return;
    }
    if (range && lastClicked && visiblePaths.includes(lastClicked)) {
      const a = visiblePaths.indexOf(lastClicked);
      const b = visiblePaths.indexOf(fullPath);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const slice = visiblePaths.slice(lo, hi + 1);
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
    haptic("selection");
    setSelectedPaths(visiblePaths);
  }

  function clearSelection() {
    haptic("selection");
    setSelectedPaths([]);
    setLastClicked(null);
  }

  /** Can this row open in the viewer? Trash keeps session kinds closed. */
  function canOpenEntry(ctx) {
    if (ctx.entry.kind !== "file" || !canViewerOpen(ctx.displayName)) return false;
    if (trashView && viewerNeedsSession(ctx.displayName)) return false;
    return true;
  }

  function openEntry(ctx) {
    haptic("medium");
    if (ctx.entry.kind === "dir") {
      openFolder(ctx.fullPath, { feedback: false });
      return;
    }
    if (onOpenFile && canOpenEntry(ctx)) {
      onOpenFile(ctx);
    }
  }

  async function handleOsDrop(event, destPath) {
    event.preventDefault();
    clearSpringLoad();
    setDropTarget(null);
    const files = await filesFromDataTransfer(event.dataTransfer);
    if (files.length) {
      haptic("heavy");
      if (onUploadFiles) {
        await onUploadFiles(files, destPath);
      }
    }
  }

  function onRowDragStart(ctx, event) {
    if (isPicker || trashView || !onInternalMove) return;
    const origin = event.target;
    if (origin instanceof Element && origin.closest("[data-no-row-drag]")) {
      event.preventDefault();
      return;
    }
    haptic("rigid");
    const paths = selectedPaths.includes(ctx.fullPath) && selectedPaths.length
      ? selectedPaths
      : [ctx.fullPath];
    dragPathsRef.current = paths;
    setLunaDragActive(true);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(LUNA_PATHS_MIME, JSON.stringify(paths));
    event.dataTransfer.setData(LUNA_DRIVE_MIME, driveId);
    event.dataTransfer.setData("text/plain", paths.join("\n"));
  }

  async function onFolderDrop(destFolder, event) {
    event.preventDefault();
    event.stopPropagation();
    clearSpringLoad();
    setLunaDragActive(false);
    setDropTarget(null);
    haptic("heavy");
    const osFiles = await filesFromDataTransfer(event.dataTransfer);
    if (osFiles.length && onUploadFiles) {
      await onUploadFiles(osFiles, destFolder);
      return;
    }
    if (!onInternalMove) return;
    const paths = readLunaPaths(event.dataTransfer, dragPathsRef.current);
    // A spring-loaded drag can arrive from another drive's browser — its
    // payload carries the source drive. The same-drive guard (never drop a
    // folder into itself) only applies when source and target match.
    const sourceDriveId = readLunaDrive(event.dataTransfer);
    const sameDrive = !sourceDriveId || sourceDriveId === driveId;
    const filtered = (paths || []).filter((p) => {
      if (!p) return false;
      if (!sameDrive) return true;
      // Never drop a folder into itself or one of its own descendants.
      if (p === destFolder || destFolder.startsWith(`${p}/`)) return false;
      // Dropping onto the folder an item already lives in is a no-op —
      // this is what makes current-folder targets safe to accept.
      if (parentPath(p) === destFolder) return false;
      return true;
    });
    if (filtered.length) await onInternalMove(filtered, destFolder, undefined, sourceDriveId);
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
          aria-label={selected ? `Selected ${ctx.displayName}` : `Select ${ctx.displayName}`}
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
            aria-label={`Copy ${ctx.displayName}`}
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
            aria-label={`Move ${ctx.displayName}`}
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
            aria-label={`Rename ${ctx.displayName}`}
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
            aria-label={`Move ${ctx.displayName} to trash`}
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
            aria-label={`Download ${ctx.displayName}`}
          >
            <a href={source.downloadHref(driveId, ctx.fullPath, ctx.entry.kind)}>
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
  const allSelected = visiblePaths.length > 0 && visiblePaths.every((p) => selectedPaths.includes(p));
  const selectedCount = selectedPaths.length;
  const showSelectionToolbar = !isPicker && multiSelect && !trashView && selectedCount > 0;
  // The browser background is itself a drop target ("::current") for the
  // folder being browsed — no visible highlight, only the a11y status.
  const currentFolderDrop = dropTarget === "::current";
  // "Move into this folder" chip — only useful while an internal drag is in
  // flight AND at least one dragged item lives outside the folder being
  // browsed. Foreign drags (spring-loaded in from another drive's browser)
  // leave dragPathsRef empty, so they're always treated as from elsewhere.
  const lunaDragFromElsewhere = dragPathsRef.current.length === 0
    || dragPathsRef.current.some((p) => parentPath(p) !== path);
  const showHereDrop = lunaDragActive && !isPicker && !trashView && Boolean(onInternalMove) && lunaDragFromElsewhere;

  // The chip stays mounted through its slide-out — same exit-delay pattern as
  // the fullscreen overlays. Reduced motion unmounts it immediately.
  const [hereDropMounted, setHereDropMounted] = useState(false);
  const hereDropExitRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const hereDropClosing = hereDropMounted && !showHereDrop;

  // Mount synchronously during render so a drag restarting mid-exit never
  // drops a frame (same pattern as FileViewer's useOverlayPresence).
  if (showHereDrop && !hereDropMounted) {
    setHereDropMounted(true);
  }

  useEffect(() => {
    if (showHereDrop) {
      if (hereDropExitRef.current != null) {
        clearTimeout(hereDropExitRef.current);
        hereDropExitRef.current = null;
      }
      return;
    }
    if (!hereDropMounted || hereDropExitRef.current != null) return;
    const reduceMotion = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    hereDropExitRef.current = setTimeout(() => {
      hereDropExitRef.current = null;
      setHereDropMounted(false);
    }, reduceMotion ? 0 : 220);
  }, [showHereDrop, hereDropMounted]);
  useEffect(() => () => {
    if (hereDropExitRef.current != null) clearTimeout(hereDropExitRef.current);
  }, []);
  const showTrashEntry = Boolean(trashHref && !isPicker && path === "" && entries.length > 0);

  const emptyTrashAction = trashHref && !isPicker && path === "" ? (
    <div className="flex flex-wrap justify-center gap-2">
      {emptyAction}
      <Button variant="outline" surface="secondary" size="sm" asChild>
        <Link to={trashHref} draggable={false}>Open Trash</Link>
      </Button>
    </div>
  ) : emptyAction;

  const folderActionButtons = hasFolderActions ? (
    <>
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
    </>
  ) : null;

  return (
    <div
      className={className}
      data-slot="file-browser"
      onDragOver={(e) => {
        if (isPicker || trashView) return;
        const isLuna = Boolean(onInternalMove) && hasLunaPaths(e);
        const isOsFiles = Boolean(enableUploadDrop) && hasOsFiles(e);
        if (!isOsFiles && !isLuna) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = isLuna ? "move" : "copy";
        if (isLuna) setLunaDragActive(true);
        setDropTarget("::current");
      }}
      onDragLeave={(e) => {
        // Ignore leave events that stay within this browser (child→child).
        if (e.currentTarget.contains(/** @type {Node|null} */ (e.relatedTarget))) return;
        setLunaDragActive(false);
        setDropTarget(null);
        clearSpringLoad();
      }}
      // dragend bubbles up from the source row — cancel any pending nav.
      onDragEnd={() => {
        clearSpringLoad();
        setLunaDragActive(false);
      }}
      onDrop={(e) => {
        if (isPicker || trashView) return;
        setLunaDragActive(false);
        const isLuna = hasLunaPaths(e);
        // The browser background is a drop target for the folder being
        // browsed: internal drags move into `path`, OS files upload into it.
        if (isLuna) {
          if (onInternalMove) void onFolderDrop(path, e);
          return;
        }
        if (!enableUploadDrop) return;
        void handleOsDrop(e, path);
      }}
    >
      {showBreadcrumbs && (
        <div
          ref={folderChromeRef}
          // Do not use overflow-x-hidden here. CSS couples the axes, so a
          // hidden X makes Y compute to auto and clips the card's left edge.
          // The measure probe is already clipped in its own 0×0 box.
          className="relative mb-3"
          data-slot={
            folderChromeSplit
              ? "file-browser-folder-chrome-split"
              : "file-browser-folder-chrome-combined"
          }
        >
          {hasFolderActions ? (
            <div
              className="pointer-events-none absolute left-0 top-0 z-[-1] h-0 w-0 overflow-hidden opacity-0"
              aria-hidden="true"
              data-slot="file-browser-folder-chrome-probe"
            >
              <div
                ref={folderChromeProbeRef}
                className="flex w-max items-start whitespace-nowrap"
                style={{ gap: FOLDER_ROW_GAP }}
              >
                <div className="shrink-0">
                  <p className="text-xs font-mono uppercase tracking-widest text-primary mb-1">
                    Current folder
                  </p>
                  <div className="flex items-center gap-2 font-mono text-sm text-primary">
                    <span>{driveLabel}</span>
                    {segments.map((segment, i) => (
                      <span key={`probe-${segment}-${i}`} className="flex items-center gap-2">
                        <span aria-hidden="true">/</span>
                        <span>{segmentLabel ? segmentLabel(segment, i) : segment}</span>
                      </span>
                    ))}
                    {breadcrumbExtra}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  {folderActions}
                  {enableUploadDrop && !isPicker ? (
                    <Button variant="outline" surface="secondary" size="sm" type="button" tabIndex={-1}>
                      <UploadCloud size={14} aria-hidden="true" />
                      Upload
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          <Card padding>
            <div
              className={cn(
                "flex items-start gap-3",
                !folderChromeSplit && hasFolderActions && "justify-between",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs font-mono uppercase tracking-widest text-primary mb-1">
                  Current folder
                </p>
                <div
                  className="flex flex-wrap items-center gap-2 font-mono text-sm text-primary"
                  aria-live="polite"
                >
                  {(() => {
                    const isRootDrop = dropTarget === "::root";
                    // The root crumb stays a valid target at the drive root
                    // (drags arriving from elsewhere can land there); items
                    // already at root are filtered as no-ops in onFolderDrop.
                    const rootDropProps = folderDropProps("::root", "");

                    // Permanent pill footprint (`px-1` balanced by `-mx-1`)
                    // so the accent ring hugs the rounded crumb without
                    // shifting the rest of the trail when it appears.
                    return linkNavigation ? (
                      <TextLink
                        to={folderHref(driveId, "")}
                        surface="secondary"
                        className={cn(
                          "break-all text-primary rounded-pill px-1 -mx-1",
                          isRootDrop && "bg-accent/20 ring-2 ring-accent",
                        )}
                        draggable={false}
                        {...rootDropProps}
                      >
                        {driveLabel}
                      </TextLink>
                    ) : (
                      <button
                        type="button"
                        {...rootDropProps}
                        className={cn(
                          "text-primary hover:text-accent motion-safe:transition-colors break-all text-left rounded-pill px-1 -mx-1",
                          isRootDrop && "bg-accent/20 ring-2 ring-accent",
                        )}
                        onClick={() => openFolder("")}
                      >
                        {driveLabel}
                      </button>
                    );
                  })()}
                  {segments.map((segment, i) => {
                    const segPath = segments.slice(0, i + 1).join("/");
                    const isSegDrop = dropTarget === `::seg::${segPath}`;
                    // The current (last) segment is a valid target too —
                    // dropping moves items into the folder being browsed;
                    // items already inside it are filtered as no-ops in
                    // onFolderDrop. armSpringLoad already skips `segPath === path`.
                    const segDropProps = folderDropProps(`::seg::${segPath}`, segPath);

                    return (
                      <span key={`${segment}-${i}`} className="flex items-center gap-2 min-w-0">
                        <span className="text-primary" aria-hidden="true">/</span>
                        {linkNavigation ? (
                          <TextLink
                            to={folderHref(driveId, segPath)}
                            surface="secondary"
                            className={cn(
                              "break-all text-primary rounded-pill px-1 -mx-1",
                              isSegDrop && "bg-accent/20 ring-2 ring-accent",
                            )}
                            draggable={false}
                            {...segDropProps}
                          >
                            {segmentLabel ? segmentLabel(segment, i) : segment}
                          </TextLink>
                        ) : (
                          <button
                            type="button"
                            {...segDropProps}
                            className={cn(
                              "text-primary hover:text-accent motion-safe:transition-colors break-all text-left rounded-pill px-1 -mx-1",
                              isSegDrop && "bg-accent/20 ring-2 ring-accent",
                            )}
                            onClick={() => openFolder(segPath)}
                          >
                            {segmentLabel ? segmentLabel(segment, i) : segment}
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
              {hasFolderActions && !folderChromeSplit ? (
                <div className="shrink-0 flex flex-wrap items-center justify-end gap-2">
                  {folderActionButtons}
                </div>
              ) : null}
            </div>
            {(showUpButton && up !== null) || headerExtra || hereDropMounted ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {showUpButton && up !== null && (() => {
                  const isUpDrop = dropTarget === "::up";
                  const upDropProps = folderDropProps("::up", up);

                  return linkNavigation ? (
                    <Button
                      variant="outline"
                      surface="secondary"
                      size="sm"
                      asChild
                      className={cn(isUpDrop && "border-transparent ring-2 ring-accent bg-accent/20")}
                      {...upDropProps}
                    >
                      <Link to={folderHref(driveId, up)} draggable={false}>↑ Up one folder</Link>
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      surface="secondary"
                      size="sm"
                      className={cn(isUpDrop && "border-transparent ring-2 ring-accent bg-accent/20")}
                      onClick={() => openFolder(up)}
                      {...upDropProps}
                    >
                      ↑ Up one folder
                    </Button>
                  );
                })()}
                {hereDropMounted ? (() => {
                  // Explicit "drop into the folder being browsed" target —
                  // slides in from behind "Up one folder" while an internal
                  // drag is in flight. Dotted at rest; on drag-hover the
                  // dotted border goes transparent so the single accent ring
                  // is the outline.
                  const isHereDrop = dropTarget === "::here";
                  return (
                    <Button
                      variant="outline"
                      surface="secondary"
                      size="sm"
                      smoothResize={false}
                      aria-label="Drop files here to move them into this folder"
                      className={cn(
                        "border-dotted border-accent",
                        hereDropClosing
                          ? "slide-out-to-left-pop animate-out"
                          : "slide-in-from-left-pop animate-in duration-300",
                        isHereDrop && "border-transparent ring-2 ring-accent bg-accent/20",
                      )}
                      // backwards (not both) while open: drop the transform
                      // after the slide so no leftover compositing layer.
                      // animate-out's `both` is fine for the exit — the chip
                      // unmounts at the end anyway.
                      style={hereDropClosing ? undefined : { animationFillMode: "backwards" }}
                      onDragOver={(e) => {
                        if (!hasLunaPaths(e)) return;
                        e.preventDefault();
                        e.stopPropagation();
                        e.dataTransfer.dropEffect = "move";
                        setDropTarget("::here");
                      }}
                      onDragLeave={(e) => {
                        if (e.currentTarget.contains(/** @type {Node|null} */ (e.relatedTarget))) return;
                        if (dropTarget === "::here") setDropTarget(null);
                      }}
                      onDrop={(e) => {
                        void onFolderDrop(path, e);
                      }}
                    >
                      <FolderInput size={14} aria-hidden="true" />
                      Move into this folder
                    </Button>
                  );
                })() : null}
                {headerExtra}
              </div>
            ) : null}
          </Card>

          {hasFolderActions && folderChromeSplit ? (
            <Card className="mt-3" padding>
              <div
                className="flex flex-wrap items-center justify-center gap-2 min-h-10"
                role="toolbar"
                aria-label="Folder actions"
              >
                {folderActionButtons}
              </div>
            </Card>
          ) : null}
        </div>
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
                displayName: pathBasenameSafe(path) || driveLabel,
              })}
            >
              {selectedPath === path ? "Using this folder" : "Use this folder"}
            </Button>
          </div>
        </Card>
      )}

      {listing.isError && (
        <p className="text-error text-sm mb-3" role="alert">
          {folderListingError(listing.error)}
        </p>
      )}

      <Card
        padding={false}
        className={listClassName}
        aria-busy={listBusy || undefined}
      >
        {currentFolderDrop ? (
          <span className="sr-only" role="status">
            Drop to put items in this folder
          </span>
        ) : null}
        {entries.length > 0 && (
          <div
            data-slot="file-browser-column-header"
            className={`min-h-11 flex flex-wrap items-center gap-2 px-3 py-1 border-b border-primary/20 motion-safe:transition-colors ${
              showSelectionToolbar ? "bg-accent/20" : ""
            }`}
            // The column header is not a drop target: swallow dragovers before
            // the container's catch-all can claim them, and clear any lit
            // drop highlight so the header stays completely inert.
            onDragEnterCapture={(e) => {
              e.stopPropagation();
              setDropTarget(null);
            }}
            onDragOverCapture={(e) => {
              e.stopPropagation();
              setDropTarget(null);
            }}
            onDropCapture={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            role={showSelectionToolbar ? "toolbar" : "group"}
            aria-label={showSelectionToolbar ? "Actions for selected files" : "Sort and filter this folder"}
          >
            {!isPicker && multiSelect && !trashView ? (
              <AnimatedCheckbox
                checked={allSelected}
                onChange={(next) => (next ? selectAllVisible() : clearSelection())}
                aria-label="Select all in this folder"
                surface="secondary"
              />
            ) : null}
            {/* The two header states swap on a vertical spatial model: the
                selection bar rises in from the bottom edge; clearing sends
                the browse controls back down from the top. `key` remounts
                each side so the entrance replays on every flip — no exit
                layer, so stale controls never linger in the DOM. */}
            {showSelectionToolbar ? (
              <div
                key="selecting"
                className="flex flex-nowrap items-center gap-2 flex-1 min-w-0 overflow-x-auto animate-in slide-in-from-bottom-2"
                style={{ animationFillMode: "backwards" }}
              >
                {/* Count ticks upward on each change — remounting the span
                    replays the micro-slide like an odometer. */}
                <span
                  key={selectedCount}
                  className="font-mono text-xs text-primary shrink-0 whitespace-nowrap animate-in slide-in-from-bottom-1 duration-200"
                  style={{ animationFillMode: "backwards" }}
                >
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
                    className="shrink-0 animate-in slide-in-from-left-2"
                    style={{ animationFillMode: "backwards" }}
                    onClick={() => {
                      const fullPath = selectedPaths[0];
                      const name = fullPath.split("/").pop() || fullPath;
                      const entry = entries.find((e) => joinPath(path, e.name) === fullPath)
                        || { name, kind: "file" };
                      onShare({ entry, path, fullPath, displayName: displayNameOf(entry) });
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
                    className="shrink-0 animate-in slide-in-from-left-2"
                    style={{ animationFillMode: "backwards" }}
                    asChild
                  >
                    <a href={source.downloadHref(driveId, selectedPaths[0])}>Download</a>
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
                    <Copy size={14} aria-hidden="true" />
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
                    <FolderInput size={14} aria-hidden="true" />
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
                {renderSelectionActions?.(
                  selectedPaths,
                  selectedPaths
                    .map((p) => entries.find((e) => joinPath(path, e.name) === p))
                    .filter(Boolean)
                    .map((e) => rowContext(e)),
                )}
                {toolbarExtra}
              </div>
            ) : (
              <div
                key="browsing"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2 animate-in slide-in-from-top-2"
                style={{ animationFillMode: "backwards" }}
              >
                <div className="flex min-w-36 flex-1 items-center gap-2 rounded-pill border-2 border-transparent bg-primary px-3 py-1 focus-within:border-accent motion-safe:transition-colors">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <Search size={14} className="shrink-0 text-accent" aria-hidden="true" />
                    <input
                      type="text"
                      className="min-w-0 flex-1 appearance-none border-0 bg-transparent text-sm text-secondary shadow-none outline-none no-focus-outline placeholder:text-accent"
                      placeholder="Find in this folder"
                      aria-label="Find in this folder"
                      value={filterText}
                      onChange={(e) => setFilterText(e.target.value)}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                    {narrowed ? (
                      <span className="shrink-0 font-mono text-xs text-accent">
                        {visibleEntries.length} of {entries.length}
                      </span>
                    ) : null}
                  </label>
                  {filterText ? (
                    <Button
                      variant="ghost"
                      surface="primary"
                      size="iconSm"
                      aria-label="Clear the folder filter"
                      onClick={() => setFilterText("")}
                    >
                      <X size={14} />
                    </Button>
                  ) : null}
                </div>
                <SegmentedControl
                  surface="secondary"
                  value={kindFilter}
                  onChange={setKindFilter}
                  aria-label="Show"
                  options={[
                    { value: "all", label: "All" },
                    { value: "dir", label: "Folders", icon: Folder },
                    { value: "file", label: "Files", icon: FileIcon },
                  ]}
                />
                <Dropdown
                  bg="primary"
                  options={SORT_OPTIONS}
                  value={sortKey}
                  onChange={changeSort}
                  aria-label="Sort files"
                />
              </div>
            )}
          </div>
        )}

        {listBusy && entries.length === 0 ? (
          <div className="h-11" aria-hidden="true" />
        ) : (
          <ul
            ref={listRef}
            className={["m-0 p-0 list-none flex flex-col", showingStaleListing ? "pointer-events-none" : ""]
              .filter(Boolean)
              .join(" ")}
            aria-label="Files and folders"
            {...(showingStaleListing ? { inert: true } : {})}
          >
            {showTrashEntry ? (() => {
              const isTrashDrop = dropTarget === "::trash";
              return (
                <li
                  className={[
                    "flex items-center gap-2 px-3",
                    padY,
                    "bg-secondary text-primary",
                    // One outline: the drop ring replaces the row separator
                    // (border-b kept transparent so the row height doesn't shift).
                    isTrashDrop
                      ? "bg-accent/20 ring-2 ring-accent ring-inset border-b border-transparent last:border-b-0 last:rounded-b-large-element"
                      : "border-b border-primary/15 last:border-b-0 last:rounded-b-large-element",
                    "motion-safe:transition-colors",
                  ].join(" ")}
                  onDragOver={(e) => {
                    if (!onDelete || !hasLunaPaths(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "move";
                    setDropTarget("::trash");
                  }}
                  onDragLeave={(e) => {
                    if (e.currentTarget.contains(/** @type {Node|null} */ (e.relatedTarget))) return;
                    if (dropTarget === "::trash") setDropTarget(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    clearSpringLoad();
                    setLunaDragActive(false);
                    setDropTarget(null);
                    const paths = readLunaPaths(e.dataTransfer, dragPathsRef.current);
                    if (paths.length && onDelete) {
                      onDelete(paths);
                    }
                    dragPathsRef.current = [];
                  }}
                >
                  {!isPicker && multiSelect ? (
                    <span className="w-5 shrink-0" aria-hidden="true" />
                  ) : null}
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {linkNavigation ? (
                      <Link
                        to={trashHref}
                        draggable={false}
                        className="flex items-center gap-2 min-w-0 text-primary hover:underline"
                      >
                        <Trash2 size={16} className="text-accent shrink-0" aria-hidden="true" />
                        <span className="font-mono text-sm truncate">Trash</span>
                      </Link>
                    ) : (
                      <a
                        href={trashHref}
                        draggable={false}
                        className="flex items-center gap-2 min-w-0 text-primary hover:underline"
                      >
                        <Trash2 size={16} className="text-accent shrink-0" aria-hidden="true" />
                        <span className="font-mono text-sm truncate">Trash</span>
                      </a>
                    )}
                  </div>
                  <div className="shrink-0 w-28" aria-hidden="true" />
                </li>
              );
            })() : null}
            {visibleEntries.map((entry) => {
              const ctx = rowContext(entry);
              const isSelected = selectedPaths.includes(ctx.fullPath);
              const isDrop = dropTarget === ctx.fullPath;
              const openable = canOpenEntry(ctx);
              const canDragRow = !isPicker && !trashView && Boolean(onInternalMove);

              return (
                <li
                  key={entry.name}
                  data-file-path={ctx.fullPath}
                  className={[
                    "flex items-center gap-2 px-3",
                    padY,
                    "bg-secondary text-primary",
                    isSelected ? "bg-accent/20" : "",
                    // One outline: the drop ring replaces the row separator
                    // (border-b kept transparent so the row height doesn't
                    // shift). The last row always rounds to hug the card's
                    // bottom edge — same geometry whether or not it's the
                    // drop target.
                    isDrop
                      ? "bg-accent/20 ring-2 ring-accent ring-inset border-b border-transparent last:border-b-0 last:rounded-b-large-element"
                      : "border-b border-primary/15 last:border-b-0 last:rounded-b-large-element",
                    "motion-safe:transition-colors",
                    canDragRow ? "cursor-grab active:cursor-grabbing select-none" : "",
                  ].filter(Boolean).join(" ")}
                  draggable={canDragRow}
                  onDragStart={(e) => onRowDragStart(ctx, e)}
                  {...(entry.kind === "dir" ? folderDropProps(ctx.fullPath, ctx.fullPath) : {})}
                >
                  {!isPicker && multiSelect && !trashView ? (
                    <div
                      data-no-row-drag
                      draggable={false}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="shrink-0"
                    >
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
                        aria-label={`Select ${ctx.displayName}`}
                        surface="secondary"
                      />
                    </div>
                  ) : null}

                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {entry.kind === "dir" ? (
                      linkNavigation ? (
                        <Link
                          to={folderHref(driveId, ctx.fullPath)}
                          draggable={false}
                          className="flex items-center gap-2 min-w-0 text-primary hover:underline"
                        >
                          <Folder size={16} className="text-accent shrink-0" aria-hidden="true" />
                          <span className="font-mono text-sm truncate">{ctx.displayName}</span>
                        </Link>
                      ) : (
                        <button
                          type="button"
                          draggable={false}
                          className="flex items-center gap-2 min-w-0 text-left text-primary hover:underline"
                          onClick={() => openEntry(ctx)}
                        >
                          <Folder size={16} className="text-accent shrink-0" aria-hidden="true" />
                          <span className="font-mono text-sm truncate">{ctx.displayName}</span>
                        </button>
                      )
                    ) : openable ? (
                      linkNavigation ? (
                        <Link
                          to={fileHref(driveId, ctx.fullPath)}
                          draggable={false}
                          className="flex items-center gap-2 min-w-0 text-primary hover:underline"
                          onClick={() => {
                            haptic("medium");
                            onOpenFile?.(ctx);
                          }}
                        >
                          <FileIcon size={16} className="text-accent shrink-0" aria-hidden="true" />
                          <span className="font-mono text-sm truncate">{ctx.displayName}</span>
                        </Link>
                      ) : (
                        <button
                          type="button"
                          draggable={false}
                          className="flex items-center gap-2 min-w-0 text-left text-primary hover:underline"
                          onClick={() => openEntry(ctx)}
                        >
                          <FileIcon size={16} className="text-accent shrink-0" aria-hidden="true" />
                          <span className="font-mono text-sm truncate">{ctx.displayName}</span>
                        </button>
                      )
                    ) : (
                      <div className="flex items-center gap-2 min-w-0 text-primary" draggable={false}>
                        <FileIcon size={16} className="text-accent shrink-0" aria-hidden="true" />
                        <span className="font-mono text-sm truncate">{ctx.displayName}</span>
                      </div>
                    )}
                    {entry.saving ? (
                      <span className="text-xs text-accent shrink-0" aria-live="polite">
                        Saving…
                      </span>
                    ) : null}
                    {!isPicker && !trashView && (!source.guest || ((source.capsBits ?? 0) & CAP.VIEW) !== 0) && entry.kind === "file" && isFormFile(entry.name) ? (
                      <FormResponseBadge driveId={driveId} formPath={ctx.fullPath} />
                    ) : null}
                  </div>

                  <div
                    data-no-row-drag
                    className="shrink-0 max-w-[40%] sm:max-w-none flex flex-wrap items-center justify-end gap-0.5"
                    draggable={false}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    {rowActions(ctx)}
                    {!isPicker && (
                      <PropertiesButton
                        label={ctx.displayName}
                        onClick={() => setPropertiesCtx(ctx)}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {!listBusy && !listing.isError && entries.length === 0 && !showTrashEntry && (
        <EmptyState className="mt-4" icon={EmptyIcon} title={emptyTitle} description={emptyDescription} action={emptyTrashAction} />
      )}

      {!listBusy && !listing.isError && entries.length > 0 && visibleEntries.length === 0 && (
        <EmptyState
          className="mt-4"
          icon={SearchX}
          title={
            filterText.trim()
              ? `Nothing matches "${filterText.trim()}" in this folder`
              : kindFilter === "dir"
                ? "No folders in this folder"
                : "No files in this folder"
          }
          action={(
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFilterText("");
                setKindFilter("all");
              }}
            >
              Show everything
            </Button>
          )}
        />
      )}

      <PropertiesSheet
        open={propertiesCtx != null}
        driveId={driveId}
        driveLabel={driveLabel}
        path={propertiesCtx?.fullPath || ""}
        parent={propertiesCtx?.path || ""}
        entry={propertiesCtx ? { ...propertiesCtx.entry, name: propertiesCtx.displayName } : null}
        inTrash={trashView}
        onClose={() => setPropertiesCtx(null)}
      />
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
  selectPath: PropTypes.string,
  onSelectPathApplied: PropTypes.func,
  onShare: PropTypes.func,
  onCopy: PropTypes.func,
  onMove: PropTypes.func,
  onRename: PropTypes.func,
  onDelete: PropTypes.func,
  onOpenFile: PropTypes.func,
  onUploadFiles: PropTypes.func,
  onInternalMove: PropTypes.func,
  renderRowActions: PropTypes.func,
  renderSelectionActions: PropTypes.func,
  enableDownload: PropTypes.bool,
  enableUploadDrop: PropTypes.bool,
  linkNavigation: PropTypes.bool,
  folderHref: PropTypes.func,
  fileHref: PropTypes.func,
  showBreadcrumbs: PropTypes.bool,
  showUpButton: PropTypes.bool,
  segmentLabel: PropTypes.func,
  breadcrumbExtra: PropTypes.node,
  headerExtra: PropTypes.node,
  trashHref: PropTypes.string,
  toolbarExtra: PropTypes.node,
  folderActions: PropTypes.node,
  hideHidden: PropTypes.bool,
  emptyTitle: PropTypes.string,
  emptyIcon: PropTypes.elementType,
  emptyDescription: PropTypes.string,
  emptyAction: PropTypes.node,
  className: PropTypes.string,
  listClassName: PropTypes.string,
  dense: PropTypes.bool,
};
