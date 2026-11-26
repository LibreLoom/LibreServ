import { useCallback, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { defaultRangeExtractor, useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  Archive,
  Check,
  ChevronDown,
  Copy,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderInput,
  FolderUp,
  Pencil,
  Search,
  SearchX,
  Trash2,
  TriangleAlert,
  UploadCloud,
  X,
} from "lucide-react";
import PropTypes from "prop-types";
import { cn } from "@libreloom/ui/lib/utils.js";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import TextLink from "../ui/TextLink.jsx";
import AnimatedCheckbox from "@libreloom/ui/components/ui/AnimatedCheckbox.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { ActionTooltipGroup, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import RollingNumber from "@libreloom/ui/components/common/RollingNumber.jsx";
import SlideCollapse from "@libreloom/ui/components/common/SlideCollapse.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useShortcut } from "@libreloom/ui/context/ShortcutsContext.jsx";
import ToastContext from "@libreloom/ui/context/ToastContext.jsx";
import { fileListKey, fileSourceScope, useFileSource } from "../../lib/fileSource.jsx";
import { canSeeLinks } from "../../lib/access.js";
import { openFileSearch } from "../../lib/fileSearch.js";

const UNPLUGGED_DRIVE_MESSAGE =
  "Luna can't find this drive. Make sure it's plugged in. If it is, unplug it and plug it back in.";

/** Listing failed because the on-drive database is gone, not because the drive left. */
function isMissingDriveDb(error) {
  if (!error) return false;
  if ("code" in error && error.code === "missing_drive_db") return true;
  return String(error.message || "")
    .toLowerCase()
    .includes("database for this drive is missing");
}

const FOLDER_GONE_MESSAGE = "This folder isn't here anymore. It may have been deleted.";

/** How long a folder may load before the list says it's still working. */
const SLOW_LISTING_MS = 1500;

function isFolderGone(error) {
  return Boolean(error) && "code" in error && error.code === "not_found"
    && !isMissingDriveDb(error);
}

function folderListingError(error) {
  const message = String(error?.message || "");
  if (isMissingDriveDb(error)) {
    return (
      message ||
      "Luna can't write its database to this drive, but your files are still on it. Free up space or check the drive's write-lock switch, then try again."
    );
  }
  const code = error && "code" in error ? error.code : null;
  // A missing folder was moved, renamed, or deleted — the drive is fine.
  // (Moved folders are followed before this shows; see useMovedLinkForwarding.)
  if (code === "not_found") return FOLDER_GONE_MESSAGE;
  // Only lunad's own "unknown drive" answer (or a bare 404) means the drive is
  // gone. Other drive errors (locked, read-only, full) say what is wrong.
  const unplugged =
    code === "unknown_drive" ||
    (!code && error && "status" in error && error.status === 404);
  if (unplugged) return UNPLUGGED_DRIVE_MESSAGE;
  return message || "Luna couldn't open this folder. Try again.";
}
import { filesFromFileList, takeDropped } from "../../lib/collectUploadFiles.js";
import {
  LUNA_DRIVE_MIME,
  LUNA_PATHS_MIME,
  SPRING_LOAD_MS,
  hasLunaPaths,
  hasOsFiles,
  readLunaDrive,
  readLunaPaths,
} from "../../lib/dnd.js";
import FileRow from "./FileRow.jsx";
import { perfSinceNavigation } from "../../lib/perf.js";
import { whenIdleAndStill } from "../../lib/whenStill.js";
import usePerfJourney from "../../hooks/usePerfJourney.js";
import { warmTextEditor } from "./editorWarm.js";
import { canOpenRow, displayNameOf, useIsSmUp } from "./fileRowUtils.js";
import PrivateBadge from "../private/PrivateBadge.jsx";
import PropertiesSheet, { PropertiesButton } from "./PropertiesSheet.jsx";
import {
  fileHref as defaultFileHref,
  folderHref as defaultFolderHref,
  isTrashPath,
  joinPath,
  parentPath,
  pathBasename,
  TRASH_PATH,
} from "../../lib/paths.js";
import { pathContains, pathKey } from "../../lib/shareTree.js";

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

/** `webkitdirectory` picks a whole folder; React's input types don't list it. */
const FOLDER_INPUT = { webkitdirectory: "" };

/** Folder pickers need `webkitdirectory`; a few browsers lack it. */
function browserCanPickFolder() {
  return typeof document !== "undefined" && "webkitdirectory" in document.createElement("input");
}

const UPLOAD_MENU_OPTIONS = [
  { value: "files", label: "Upload files", icon: UploadCloud },
  { value: "folder", label: "Upload a folder", icon: FolderUp },
];

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
/** Folders longer than this render only the rows near the viewport. */
const VIRTUALIZE_AFTER = 80;
/** Rows mounted past each edge of the viewport while scrolling. */
const ROW_OVERSCAN = 12;
/**
 * Rows kept behind the viewport while a scroll is moving away from them:
 * enough for one frame of a turn back. Every mounted row costs each scroll
 * frame layout and paint time, so the far side keeps few (W6). The full
 * overscan comes back once the scroll comes to rest.
 */
const ROW_OVERSCAN_BEHIND = 3;
/** While a scroll is moving, rows mounted ahead of it, as a multiple of ROW_OVERSCAN. */
const ROW_AHEAD_FACTOR = 4;
/** The same on a folder's first frame (see fullOverscan). */
const FIRST_FRAME_OVERSCAN = 2;
/** A row's height: rows have min-h-12 / min-h-11 (FileRow), so this is exact unless a row wraps. */
const ROW_HEIGHT_GUESS = 48;
const DENSE_ROW_HEIGHT_GUESS = 44;
const SORT_STORAGE_KEY = "luna.files.sort";

/** @type {WeakMap<object, boolean>} */
const savingCache = new WeakMap();
/**
 * Whether any entry is still being written. React Query asks on every render
 * of the browser (each scroll step in a long folder), so the answer is kept
 * per listing instead of walking thousands of entries each time.
 * @param {unknown} data
 */
function anySaving(data) {
  if (!Array.isArray(data)) return false;
  let saving = savingCache.get(data);
  if (saving === undefined) {
    saving = data.some((e) => e?.saving);
    savingCache.set(data, saving);
  }
  return saving;
}
const HIDDEN_STORAGE_KEY = "luna.files.showHidden";

function readStoredHidden() {
  try {
    return window.localStorage.getItem(HIDDEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
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

/** Folders always lead; the chosen key orders within each group. */
function compareEntries(a, b, sortKey) {
  const aDir = a.kind === "dir" ? 0 : 1;
  const bDir = b.kind === "dir" ? 0 : 1;
  if (aDir !== bDir) return aDir - bDir;
  // Only a tie-break for most sorts, so compare names lazily.
  const byName = () => NAME_COLLATOR.compare(displayNameOf(a), displayNameOf(b));
  switch (sortKey) {
    case "name-desc":
      return NAME_COLLATOR.compare(displayNameOf(b), displayNameOf(a));
    case "date-desc":
      return (Number(b.modified) || 0) - (Number(a.modified) || 0) || byName();
    case "date-asc":
      return (Number(a.modified) || 0) - (Number(b.modified) || 0) || byName();
    case "size-desc":
      return (Number(b.size) || 0) - (Number(a.size) || 0) || byName();
    case "size-asc":
      return (Number(a.size) || 0) - (Number(b.size) || 0) || byName();
    case "kind": {
      const byExtension = NAME_COLLATOR.compare(
        extensionOf(displayNameOf(a)),
        extensionOf(displayNameOf(b)),
      );
      return byExtension || byName();
    }
    default:
      return byName();
  }
}

/**
 * One row in a folder listing — lunad's `FileEntry`.
 * @typedef {{
 *   name: string,
 *   kind: "dir"|"file"|"symlink"|"other"|string,
 *   size?: number,
 *   modified?: number,
 *   hidden?: boolean,
 *   saving?: boolean,
 *   save_failed?: boolean,
 *   original_name?: string,
 *   original_path?: string,
 *   link_target?: string,
 *   caps?: number|string,
 *   private?: boolean,
 *   in_private?: boolean,
 *   backupRoot?: boolean,
 *   backup?: object,
 * }} FileEntry
 * @typedef {{ entry: FileEntry, path: string, fullPath: string, displayName: string }} FileBrowserRowContext
 */

/**
 * What `/files/stat` answers — lunad's `FileStat`, plus the trash and
 * private-folder fields the API stamps on.
 * @typedef {{
 *   name?: string,
 *   kind?: string,
 *   size?: number,
 *   modified?: number,
 *   created?: number,
 *   hidden?: boolean,
 *   saving?: boolean,
 *   writable?: boolean,
 *   private?: boolean,
 *   in_private?: boolean,
 *   link_target?: string,
 *   trashed_from?: string,
 *   original_name?: string,
 *   children?: { dirs?: number, files?: number, other?: number },
 *   totals?: { bytes: number, dirs: number, files: number, other: number, complete: boolean },
 *   caps?: number|string,
 * }} FileStat
 */

/**
 * The window of rows a long folder mounts, with a spacer above and below for
 * the rest. It owns the virtualizer, so scrolling re-renders only this list
 * (and only rows that come into the window), never the whole browser (W6).
 *
 * @param {{
 *   count: number,
 *   rowKey: (index: number) => string | number,
 *   dense: boolean,
 *   cardFill: string,
 *   stripeFill: string,
 *   fullOverscan: boolean,
 *   scrollMargin: number,
 *   dragIndexRef: import("react").MutableRefObject<number>,
 *   virtualizerRef: import("react").MutableRefObject<any>,
 *   topSpacerRef: import("react").RefObject<HTMLLIElement | null>,
 *   renderRow: (index: number, measureRef: (el: Element | null) => void, slotKey: string) => import("react").ReactNode,
 * }} props
 */
function VirtualRowWindow({
  count,
  rowKey,
  dense,
  cardFill,
  stripeFill,
  fullOverscan,
  scrollMargin,
  dragIndexRef,
  virtualizerRef,
  topSpacerRef,
  renderRow,
}) {
  // Rows all share one height (min-h in FileRow), so the estimate is exact.
  // A wrong estimate made every newly mounted row while scrolling re-lay the
  // offsets of all the rows after it (W6), and learning it from the first
  // measured row was wrong too: that row can be measured before fonts settle.
  // The stock measurement rounds to whole pixels, but a row is fractional
  // (about 46.55px). The page then ran 0.45px per mounted row shorter than the
  // virtualizer's total, so its height and the list's bottom edge shifted
  // whenever the number of mounted rows changed (scroll direction, coming to
  // rest). Measure the true height so the two always agree.
  const measureRow = useCallback((element, entry) => {
    const box = entry?.borderBoxSize?.[0];
    // An empty rectangle only happens where there is no layout (jsdom tests).
    const size = box?.blockSize || element.getBoundingClientRect().height || element.offsetHeight;
    return size;
  }, []);
  const instanceRef = useRef(/** @type {any} */ (null));
  const virtualizer = useWindowVirtualizer({
    count,
    estimateSize: () => (dense ? DENSE_ROW_HEIGHT_GUESS : ROW_HEIGHT_GUESS),
    measureElement: measureRow,
    overscan: fullOverscan ? ROW_OVERSCAN : FIRST_FRAME_OVERSCAN,
    // Scrolling must not synchronously re-render the whole list on every event.
    useFlushSync: false,
    scrollMargin,
    getItemKey: rowKey,
    initialRect: { width: 1024, height: typeof window === "undefined" ? 800 : window.innerHeight },
    // A scroll under way keeps few rows behind it (ROW_OVERSCAN_BEHIND).
    rangeExtractor: (range) => {
      const instance = instanceRef.current;
      const direction = instance?.isScrolling ? instance.scrollDirection : null;
      const behind = Math.min(range.overscan, ROW_OVERSCAN_BEHIND);
      // Ahead of a scroll in motion, mount several times the resting headroom: a fast
      // flick (or a slow frame) must not outrun the mounted rows and show a hole.
      const ahead = direction ? range.overscan * ROW_AHEAD_FACTOR : range.overscan;
      const before = direction === "forward" ? behind : direction === "backward" ? ahead : range.overscan;
      const after = direction === "backward" ? behind : direction === "forward" ? ahead : range.overscan;
      const base = defaultRangeExtractor({
        ...range,
        startIndex: Math.max(0, range.startIndex - before),
        endIndex: Math.min(range.count - 1, range.endIndex + after),
        overscan: 0,
      });
      // The row being dragged stays mounted: a source node removed mid-drag
      // never fires dragend.
      const held = dragIndexRef.current;
      if (held >= 0 && held < range.count && !base.includes(held)) {
        base.push(held);
        base.sort((a, b) => a - b);
      }
      return base;
    },
  });
  useLayoutEffect(() => {
    virtualizerRef.current = virtualizer;
    return () => {
      virtualizerRef.current = null;
    };
  }, [virtualizer, virtualizerRef]);

  instanceRef.current = virtualizer;
  const items = virtualizer.getVirtualItems();
  const slots = useRowSlots();
  const keys = slots.assign(items);
  const rows = slots.elements(items, keys, renderRow, virtualizer.measureElement);
  // A recycled row can be the one holding keyboard focus. Its element now
  // shows another file, so drop the focus, as the old unmount did: Enter
  // must never act on a row the person did not pick.
  useLayoutEffect(() => {
    // This runs after every virtualizer step. Almost no row has focus, so
    // check that first and skip the DOM walk on the common path.
    const focused = slots.focusedPath;
    if (focused == null) return;
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const row = active?.closest?.("li[data-file-path]");
    if (!row) return;
    if (/** @type {HTMLElement} */ (row).dataset.filePath !== focused) active.blur();
  });
  useEffect(() => slots.trackFocus(), [slots]);
  // The spacers wear the card's row stripes, so a stretch that is not mounted
  // yet looks like rows still to draw instead of a hole in the page.
  const rowH = dense ? DENSE_ROW_HEIGHT_GUESS : ROW_HEIGHT_GUESS;
  const stripes = (firstIndex) => {
    const [first, second] = firstIndex % 2 === 0 ? [cardFill, stripeFill] : [stripeFill, cardFill];
    return {
      backgroundImage: `repeating-linear-gradient(to bottom, ${first} 0 ${rowH}px, ${second} ${rowH}px ${rowH * 2}px)`,
    };
  };
  const topPad = items.length ? Math.max(0, items[0].start - scrollMargin) : 0;
  const bottomPad = items.length
    ? Math.max(0, virtualizer.getTotalSize() - (items[items.length - 1].end - scrollMargin))
    : 0;
  return (
    <>
      <li ref={topSpacerRef} aria-hidden="true" style={{ height: topPad, ...stripes(0) }} />
      {rows}
      <li
        aria-hidden="true"
        style={{ height: bottomPad, ...stripes(items.length ? items[items.length - 1].index + 1 : 0) }}
      />
    </>
  );
}

/**
 * Recycled row elements for VirtualRowWindow. Each mounted row holds a slot;
 * a row that leaves the window gives its slot, and with it its elements, to
 * the next row that comes in. Scrolling then rewrites a few names and links
 * instead of building and throwing away ~30 elements per row, whose garbage
 * paused long scrolls for 50–80 ms at a time (W6). A row keeps its slot for
 * as long as it stays in the window, so rows in view never change elements.
 */
function useRowSlots() {
  const ref = useRef(/** @type {ReturnType<typeof createRowSlots> | null} */ (null));
  if (!ref.current) ref.current = createRowSlots();
  return ref.current;
}

function createRowSlots() {
  /** @type {Map<unknown, number>} row key → slot, this render */
  let byKey = new Map();
  /** @type {Map<unknown, number>} the same, last render (reused) */
  let spare = new Map();
  /** @type {number[]} each slot's last row index parity, so stripes rarely flip */
  const parity = [];
  /** @type {string[]} */
  const names = [];
  /** @type {number[]} */
  const takenAt = [];
  let round = 0;
  /** @type {Map<string, { index: number, element: import("react").ReactNode }>} slot key → its last row element */
  const made = new Map();
  /** @type {unknown} */
  let madeBy = null;
  /** @type {unknown} */
  let madeWith = null;
  const slots = {
    /** @type {string | null} the file path of the row that last took focus */
    focusedPath: /** @type {string | null} */ (null),
    /**
     * Slot keys for this render's rows, in order. Rows already holding a
     * slot keep it; a new row takes a free slot, one of its own parity first.
     * @param {Array<{ key: unknown, index: number }>} items
     */
    assign(items) {
      round += 1;
      const prev = byKey;
      const next = spare;
      next.clear();
      for (const item of items) {
        const slot = prev.get(item.key);
        if (slot !== undefined && takenAt[slot] !== round) {
          next.set(item.key, slot);
          takenAt[slot] = round;
        }
      }
      const keys = new Array(items.length);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const want = item.index & 1;
        let slot = next.get(item.key);
        if (slot === undefined) {
          let any = -1;
          for (let s = 0; s < parity.length; s++) {
            if (takenAt[s] === round) continue;
            if (parity[s] === want) {
              slot = s;
              break;
            }
            if (any < 0) any = s;
          }
          if (slot === undefined) slot = any >= 0 ? any : parity.length;
          next.set(item.key, slot);
          takenAt[slot] = round;
        }
        parity[slot] = want;
        keys[i] = names[slot] ?? (names[slot] = `slot-${slot}`);
      }
      byKey = next;
      spare = prev;
      return keys;
    },
    /**
     * The row elements for this render. A row still in the slot it had last
     * scroll step gets the very same element back, so React skips it without
     * comparing its ~40 props; only rows that came into the window render.
     * Any render of the browser makes a new `renderRow`, which drops them all.
     * @param {Array<{ index: number }>} items
     * @param {string[]} keys
     * @param {(index: number, measureRef: (el: Element | null) => void, slotKey: string) => import("react").ReactNode} renderRow
     * @param {(el: Element | null) => void} measureRef
     */
    elements(items, keys, renderRow, measureRef) {
      if (renderRow !== madeBy || measureRef !== madeWith) {
        made.clear();
        madeBy = renderRow;
        madeWith = measureRef;
      }
      const out = new Array(items.length);
      for (let i = 0; i < items.length; i++) {
        const index = items[i].index;
        const held = made.get(keys[i]);
        if (held && held.index === index) {
          out[i] = held.element;
        } else {
          const element = renderRow(index, measureRef, keys[i]);
          made.set(keys[i], { index, element });
          out[i] = element;
        }
      }
      return out;
    },
    /** Follow which row takes focus (see the blur in VirtualRowWindow). */
    trackFocus() {
      const onFocus = (/** @type {FocusEvent} */ event) => {
        const target = /** @type {Element | null} */ (event.target);
        const row = target?.closest?.("li[data-file-path]");
        slots.focusedPath = row ? /** @type {HTMLElement} */ (row).dataset.filePath ?? null : null;
      };
      document.addEventListener("focusin", onFocus);
      return () => document.removeEventListener("focusin", onFocus);
    },
  };
  return slots;
}

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
 *   pathFloor?: string,
 *   forbiddenState?: import("react").ReactNode,
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
 *   onUploadFiles?: (input: { dropped: import("../../lib/collectUploadFiles.js").DroppedItems } | { files: File[] }, destPath: string) => void,
 *   onInternalMove?: (paths: string[], destFolder: string, destDriveId?: string, sourceDriveId?: string) => void | Promise<void>,
 *   renderRowActions?: (ctx: FileBrowserRowContext, extraActions?: Array<{ key: string, label: string, aria: string, icon: any, run: () => void }>) => import("react").ReactNode,
 *   renderRowSheetActions?: (ctx: FileBrowserRowContext, close: () => void) => import("react").ReactNode,
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
 *   backupsHref?: string | null,
 *   toolbarExtra?: import("react").ReactNode,
 *   folderActions?: import("react").ReactNode,
 *   emptyTitle?: string,
 *   className?: string,
 *   listClassName?: string,
 *   dense?: boolean,
 *   surface?: "primary" | "secondary",
 *   isPickBlocked?: (path: string) => boolean,
 * }} props
 */
export default function FileBrowser({
  driveId,
  driveLabel = "Drive",
  initialPath = "",
  path: controlledPath,
  pathFloor = "",
  forbiddenState = null,
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
  renderRowSheetActions,
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
  backupsHref = null,
  toolbarExtra = null,
  folderActions = null,
  emptyTitle = "There's nothing here.",
  surface = "secondary",
  isPickBlocked = undefined,
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
  const folderPicker = useRef(/** @type {HTMLInputElement|null} */ (null));
  const canPickFolder = browserCanPickFolder();
  const listRef = useRef(/** @type {HTMLUListElement|null} */ (null));
  const appliedSelectRef = useRef(/** @type {string|null} */ (null));
  const folderChromeRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const folderChromeProbeRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const [measuredFolderChromeSplit, setMeasuredFolderChromeSplit] = useState(false);
  const navigate = useNavigate();
  const source = useFileSource();
  const queryClient = useQueryClient();
  const isSmUp = useIsSmUp();

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

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

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

  const listingKey = fileListKey(source, driveId, path);
  /** @param {{ signal: AbortSignal }} context */
  const fetchListing = ({ signal }) => /** @type {Promise<FileEntry[]>} */ (source.listDir(driveId, path, signal));
  // Ask for the folder during the render that opens it. useQuery only starts
  // fetching from an effect, and a navigation renders as a transition whose
  // effects wait for the next frame: ~100 ms later on a slow box (W4). Only a
  // query that never fetched (another hook may have created it idle): data,
  // an error, or a request in flight all leave it alone.
  const listingState = driveId ? queryClient.getQueryState(listingKey) : null;
  if (driveId && (!listingState || (listingState.status === "pending" && listingState.fetchStatus === "idle"))) {
    queryClient.prefetchQuery({ queryKey: listingKey, queryFn: fetchListing });
  }
  const listing = useQuery({
    queryKey: listingKey,
    queryFn: fetchListing,
    enabled: !!driveId,
    // Keep the previous folder visible while the next listing loads so the list
    // card does not collapse empty and pop back in.
    placeholderData: keepPreviousData,
    // Poll while any file is still flushing from RAM to the drive so "Saving…"
    // clears without a manual refresh.
    refetchInterval: (query) => (anySaving(query.state.data) ? 750 : false),
  });

  // W4/W5 (luna/perf): opening a folder ends once its own rows (not the
  // previous folder's placeholder) are on screen. A guest opening a shared
  // link counts toward W15 instead.
  const listingShown = listing.isSuccess && !listing.isPlaceholderData;
  usePerfJourney("W4", driveId && !isPicker && !source.guest ? `${driveId}:${path}` : null, listingShown);
  useEffect(() => {
    if (source.guest && !isPicker && listingShown) perfSinceNavigation("W15", { path: /^\/s\// });
  }, [source.guest, isPicker, listingShown]);

  const rawEntries = listing.data || [];

  // A file answered "saving" can still fail to reach the drive (unplugged
  // mid-save). Announce the moment it flips; the row keeps saying so after.
  // Optional: the browser also renders outside the app shell (tests, embeds).
  const addToast = useContext(ToastContext)?.addToast;
  const savingNamesRef = useRef(new Set());
  useEffect(() => {
    const entries = listing.data || [];
    const wasSaving = savingNamesRef.current;
    for (const e of entries) {
      if (e?.save_failed && wasSaving.has(e.name) && addToast) {
        addToast({
          type: "error",
          message: `"${e.name}" didn't save.`,
          description: "Luna couldn't write it to the drive. Upload it again.",
        });
      }
    }
    savingNamesRef.current = new Set(entries.filter((e) => e?.saving).map((e) => e.name));
  }, [listing.data, addToast]);

  // Warm the text editor as soon as the folder is on screen. It is the most
  // common file to open, and its chunk landing mid-click is what made the
  // opening animation stutter the first time. Wait for an idle moment so the
  // chunk's download and parse don't compete with the listing and thumbnails;
  // hover and focus on a text file still warm it at once. Not while the list
  // scrolls, nor the moment it shows (people scroll right away): its ~100 ms
  // parse would freeze the scroll. Skipped on Data Saver.
  useEffect(() => {
    if (!listingShown || /** @type {any} */ (navigator).connection?.saveData) return undefined;
    return whenIdleAndStill(() => {
      warmTextEditor();
    });
  }, [listingShown]);

  // A file path answers `list` with a one-entry "folder" containing the
  // file itself — member file grants are virtual roots whose ancestors are
  // not browsable. `stat` confirms it: the row then maps back onto `path`
  // so open/download/select use the granted path, not a doubled
  // `joinPath(path, name)`.
  const maybeFileRoot = Boolean(
    !listing.isPlaceholderData
      && path
      && rawEntries.length === 1
      && rawEntries[0].kind !== "dir"
      && displayNameOf(rawEntries[0]) === pathBasename(path),
  );
  const rootStat = useQuery({
    queryKey: ["file-stat", fileSourceScope(source, driveId), path],
    queryFn: () => /** @type {Promise<FileStat>} */ (source.stat(driveId, path)),
    enabled: maybeFileRoot,
  });
  const fileRoot = maybeFileRoot && rootStat.data?.kind === "file";

  const listBusy = listing.isLoading
    || Boolean(listing.isPlaceholderData)
    || (maybeFileRoot && rootStat.isPending);
  const showingStaleListing = Boolean(listing.isPlaceholderData);

  // A slow listing says so after a beat; fast ones never flash it.
  const [slowListing, setSlowListing] = useState(false);
  useEffect(() => {
    if (!listBusy) return undefined;
    const id = setTimeout(() => setSlowListing(true), SLOW_LISTING_MS);
    return () => {
      clearTimeout(id);
      setSlowListing(false);
    };
  }, [listBusy]);
  const slowFg = surface === "primary" ? "text-secondary" : "text-primary";
  const stillWorking = slowListing ? (
    <div
      data-slot="listing-slow"
      role="status"
      className={`flex items-center justify-center gap-2 py-6 px-3 text-center ${slowFg}`}
    >
      <Spinner size="sm" label="Loading folder" className={slowFg} />
      <span className="font-mono text-base">Still working…</span>
    </div>
  ) : null;

  // Dotfile visibility is a view pref, not a permission — Luna-managed
  // `.luna-<uuid>*` names never reach the listing at all, so this only
  // unhides files the member could already open by path.
  const [showHidden, setShowHidden] = useState(readStoredHidden);

  const entries = useMemo(
    // At a file root the row IS the browsed path — never hide it. Dep on
    // `listing.data` (stable ref), not rawEntries — a missing listing must
    // not mint a fresh [] and re-run the selection effect forever.
    () => (listing.data || []).filter((e) => fileRoot || showHidden || !e.hidden),
    [listing.data, showHidden, fileRoot],
  );

  // First entry wins for a repeated path, like the linear find this replaces.
  const entryByPath = useMemo(() => {
    const map = new Map();
    for (const entry of entries) {
      const fullPath = fileRoot ? path : joinPath(path, entry.name);
      if (!map.has(fullPath)) map.set(fullPath, entry);
    }
    return map;
  }, [entries, path, fileRoot]);

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
  // Deferred: the input stays instant while a big folder re-filters behind it.
  const deferredFilterText = useDeferredValue(filterText);
  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => compareEntries(a, b, sortKey)),
    [entries, sortKey],
  );
  const nameKeys = useMemo(
    () => new Map(entries.map((e) => [e, displayNameOf(e).toLowerCase()])),
    [entries],
  );
  const visibleEntries = useMemo(() => {
    const query = deferredFilterText.trim().toLowerCase();
    return sortedEntries.filter((e) => (
      (kindFilter === "all" || (kindFilter === "dir" ? e.kind === "dir" : e.kind !== "dir"))
      && (!query || nameKeys.get(e).includes(query))
    ));
  }, [sortedEntries, nameKeys, kindFilter, deferredFilterText]);

  const visiblePaths = useMemo(
    () => visibleEntries.map((e) => (fileRoot ? path : joinPath(path, e.name))),
    [visibleEntries, path, fileRoot],
  );
  const visibleIndex = useMemo(
    () => new Map(visiblePaths.map((p, i) => [p, i])),
    [visiblePaths],
  );
  // Long folders mount only the rows near the viewport (the page scrolls on
  // the window). Short folders and pickers render every row.
  const virtualOn = !isPicker && visibleEntries.length > VIRTUALIZE_AFTER;
  // A folder's first frame mounts only the rows on screen and a couple more:
  // every row carries its action buttons, and twelve rows of scroll headroom
  // nearly doubled the time to the first rows on a slow box (W4). The
  // headroom mounts once that frame has painted.
  const overscanKey = `${driveId}:${path}`;
  const [fullOverscanFor, setFullOverscanFor] = useState(/** @type {string | null} */ (null));
  const fullOverscan = fullOverscanFor === overscanKey;
  useEffect(() => {
    if (!virtualOn || !listingShown || fullOverscan) return undefined;
    let timer = 0;
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => setFullOverscanFor(overscanKey), 0);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [virtualOn, listingShown, fullOverscan, overscanKey]);
  const topSpacerRef = useRef(/** @type {HTMLLIElement|null} */ (null));
  const [scrollMargin, setScrollMargin] = useState(0);
  const dragIndexRef = useRef(-1);
  // The list window's virtualizer, for revealRow (see VirtualRowWindow).
  const virtualizerRef = useRef(/** @type {any} */ (null));
  // The virtualizer recomputes every row's offset whenever this function
  // changes, so it keeps one identity per listing, not per render (W6).
  const rowKey = useCallback((i) => visibleEntries[i]?.name ?? i, [visibleEntries]);

  // Where the rows start on the page: everything above them (breadcrumbs,
  // toolbars) can change height, so re-measure when the page layout shifts.
  useLayoutEffect(() => {
    if (!virtualOn) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const el = topSpacerRef.current;
      if (!el) return;
      const next = Math.round(el.getBoundingClientRect().top + window.scrollY);
      setScrollMargin((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    observer?.observe(document.body);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [virtualOn]);

  /**
   * Bring a row into view, mounting it first when it is outside the window.
   * @param {string} rowPath
   * @param {ScrollBehavior} [behavior]
   */
  function revealRow(rowPath, behavior = "auto") {
    const idx = visibleIndex.get(rowPath) ?? -1;
    const find = () => listRef.current?.querySelector(`[data-file-path="${cssEscape(rowPath)}"]`);
    if (virtualOn && idx >= 0 && !find()) {
      virtualizerRef.current?.scrollToIndex(idx, { align: "auto" });
    }
    window.requestAnimationFrame(() => {
      find()?.scrollIntoView?.({ block: "nearest", behavior });
    });
  }

  const narrowed = visibleEntries.length !== entries.length;
  const isFiltered = Boolean(filterText.trim() || kindFilter !== "all");

  useEffect(() => {
    if (controlledSelected !== undefined) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- props/open seed draft UI state
    setInnerSelected((prev) => prev.filter((p) => {
      const parent = parentPath(p);
      if (parent === path || (parent === "" && path === "")) {
        return entryByPath.has(p);
      }
      // Keep selection that lives outside this folder (bulk ops across nav).
      return parent !== path;
    }));
  }, [entryByPath, path, controlledSelected]);

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
    if (!entryByPath.has(selectPath)) {
      appliedSelectRef.current = selectPath;
      onSelectPathApplied?.();
      return;
    }
    appliedSelectRef.current = selectPath;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep-link select= seed
    setSelectedPaths([selectPath]);
    setLastClicked(selectPath);
    revealRow(selectPath, prefersReducedMotion() ? "auto" : "smooth");
    onSelectPathApplied?.();
    // setSelectedPaths is stable enough for this deep-link seed; listing/selectPath drive re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional seed-once-per-selectPath
  }, [selectPath, entryByPath, listBusy, onSelectPathApplied]);

  const up = parentPath(path);
  const segments = path.split("/").filter(Boolean);

  // Member grants are virtual roots: `pathFloor` is the shallowest granted
  // path containing `path`, and nothing above it is browsable. The first
  // crumb becomes the grant's basename (file name for file grants), crumbs
  // and Up never offer a path above the floor, and drop/spring-load
  // targets outside it are refused.
  const floor = pathKey(pathFloor);
  const floored = Boolean(
    floor && (path === floor || path.startsWith(`${floor}/`)),
  );
  const floorSegs = floored ? floor.split("/") : [];
  const rootCrumbPath = floored ? floor : "";
  const rootCrumbLabel = floored
    ? (segmentLabel
      ? segmentLabel(floorSegs[floorSegs.length - 1], floorSegs.length - 1)
      : floorSegs[floorSegs.length - 1])
    : driveLabel;
  const upPath = up !== null && (!floored || pathContains(floor, up)) ? up : null;

  // Keyboard: keys act on the selected rows. Pickers only pick, and dialogs
  // (which own their keys) are skipped by the shortcut layer itself.
  const filterInputRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  const focusFilterNextRef = useRef(false);
  const cursorRef = useRef(/** @type {string|null} */ (null));
  const keysOn = !isPicker;

  // The folder search bar only exists while no rows are selected, so a `/`
  // pressed with a selection clears it first and focuses the bar once it renders.
  useEffect(() => {
    if (!focusFilterNextRef.current || !filterInputRef.current) return;
    focusFilterNextRef.current = false;
    filterInputRef.current.focus();
    filterInputRef.current.select();
  });

  function selectedEntry() {
    if (selectedPaths.length !== 1) return null;
    const i = visibleIndex.get(selectedPaths[0]) ?? -1;
    return i === -1 ? null : rowContext(visibleEntries[i]);
  }

  function moveSelection(delta, extend) {
    if (visiblePaths.length === 0) return false;
    const current = cursorRef.current && selectedSet.has(cursorRef.current)
      ? cursorRef.current
      : selectedPaths[selectedPaths.length - 1];
    const from = current ? (visibleIndex.get(current) ?? -1) : -1;
    const index = from === -1
      ? (delta > 0 ? 0 : visiblePaths.length - 1)
      : Math.min(Math.max(from + delta, 0), visiblePaths.length - 1);
    const next = visiblePaths[index];
    cursorRef.current = next;
    haptic("selection");
    const anchor = lastClicked && visibleIndex.has(lastClicked) ? lastClicked : next;
    if (extend && multiSelect) {
      const [lo, hi] = [visibleIndex.get(anchor), index].sort((a, b) => a - b);
      setSelectedPaths(visiblePaths.slice(lo, hi + 1));
      if (anchor === next) setLastClicked(next);
    } else {
      setSelectedPaths([next]);
      setLastClicked(next);
    }
    revealRow(next);
    return true;
  }

  useShortcut("/", () => {
    if (selectedPaths.length > 0) {
      focusFilterNextRef.current = true;
      clearSelection();
      return true;
    }
    const input = filterInputRef.current;
    if (!input) return false;
    input.focus();
    input.select();
    return true;
  }, { label: "Search this folder", group: "Search", priority: 1, enabled: keysOn });

  useShortcut(["ArrowDown", "ArrowUp"], (event) => moveSelection(event.key === "ArrowDown" ? 1 : -1, false), {
    label: "Move through the list", group: "Files", enabled: keysOn, repeat: true,
  });
  useShortcut(["Shift+ArrowDown", "Shift+ArrowUp"], (event) => moveSelection(event.key === "ArrowDown" ? 1 : -1, true), {
    label: "Select several in a row", group: "Files", enabled: keysOn && multiSelect, repeat: true,
  });
  useShortcut("Mod+A", () => {
    if (visiblePaths.length === 0) return false;
    selectAllVisible();
    return true;
  }, { label: "Select everything in this folder", group: "Files", enabled: keysOn && multiSelect });
  useShortcut("Escape", () => {
    if (selectedPaths.length === 0) return false;
    clearSelection();
    return true;
  }, { label: "Clear the selection", group: "Files", enabled: keysOn && multiSelect });
  useShortcut("Enter", () => {
    const ctx = selectedEntry();
    if (!ctx || (ctx.entry.kind !== "dir" && !canOpenEntry(ctx))) return false;
    openEntry(ctx);
    return true;
  }, { label: "Open the selected item", group: "Files", enabled: keysOn });
  useShortcut("Space", () => {
    const ctx = selectedEntry();
    if (!ctx || !canOpenEntry(ctx)) return false;
    openEntry(ctx);
    return true;
  }, { label: "Preview the selected file", group: "Files", enabled: keysOn });
  useShortcut("Backspace", () => {
    if (upPath === null) return false;
    openFolder(upPath);
    return true;
  }, { label: "Go up one folder", group: "Files", enabled: keysOn && showUpButton });
  useShortcut("F2", () => {
    const ctx = selectedEntry();
    if (!ctx || !onRename) return false;
    onRename(ctx);
    return true;
  }, { label: "Rename", group: "Files", enabled: keysOn && Boolean(onRename) });
  useShortcut("Delete", () => {
    if (selectedPaths.length === 0 || !onDelete) return false;
    onDelete(selectedPaths);
    return true;
  }, { label: "Move to trash", group: "Files", enabled: keysOn && Boolean(onDelete) });
  useShortcut("s", () => {
    const ctx = selectedEntry();
    if (!ctx || !onShare || !canSeeLinks(ctx.entry?.caps || "")) return false;
    onShare(ctx);
    return true;
  }, { label: "Share", group: "Files", enabled: keysOn && Boolean(onShare) });
  useShortcut("d", () => {
    const ctx = selectedEntry();
    if (!ctx) return false;
    const link = document.createElement("a");
    link.href = source.downloadHref(driveId, ctx.fullPath, ctx.entry.kind);
    link.click();
    return true;
  }, { label: "Download", group: "Files", enabled: keysOn && enableDownload });
  useShortcut("u", () => {
    if (!filePicker.current) return false;
    filePicker.current.click();
    return true;
  }, { label: "Upload files", group: "Files", enabled: keysOn && enableUploadDrop });
  useShortcut("Shift+U", () => {
    if (!folderPicker.current) return false;
    folderPicker.current.click();
    return true;
  }, { label: "Upload a folder", group: "Files", enabled: keysOn && enableUploadDrop && canPickFolder });
  const listingForbidden = Boolean(
    listing.isError
      && forbiddenState
      && listing.error
      && "status" in listing.error
      && listing.error.status === 403,
  );

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

  // `folderActions` / `breadcrumbExtra` are JSX (new every render), so they are
  // not deps; the observers on the container and probe catch their width changes.
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
    enableUploadDrop,
    isPicker,
  ]);

  function openFolder(folderPath, { feedback = true } = {}) {
    if (feedback) haptic("medium");
    // Never navigate above the grant floor — ancestors aren't browsable.
    setPath(floored && !pathContains(floor, folderPath) ? floor : folderPath);
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
    // Spring-load never climbs above the grant floor.
    if (floored && !pathContains(floor, folderPath)) return;
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
    if (isPicker || (!onInternalMove && !onUploadFiles)) return {};
    // A grant floor makes ancestors unreachable — no drop target above it.
    if (floored && !pathContains(floor, destFolder)) return {};
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
        setDropTarget((current) => (current === key ? null : current));
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
      // At a file root the browsed path IS the entry's path.
      fullPath: fileRoot ? path : joinPath(path, entry.name),
      displayName: displayNameOf(entry),
    };
  }

  function toggleOne(fullPath, { additive = false, range = false } = {}) {
    haptic("selection");
    if (!multiSelect) {
      setSelectedPaths(selectedPaths[0] === fullPath ? [] : [fullPath]);
      setLastClicked(fullPath);
      return;
    }
    if (range && lastClicked && visibleIndex.has(lastClicked)) {
      const a = visibleIndex.get(lastClicked) ?? -1;
      const b = visibleIndex.get(fullPath) ?? -1;
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
        selectedSet.has(fullPath)
          ? selectedPaths.filter((p) => p !== fullPath)
          : [...selectedPaths, fullPath],
      );
    } else {
      setSelectedPaths(selectedSet.has(fullPath) && selectedPaths.length === 1 ? [] : [fullPath]);
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

  function canOpenEntry(ctx) {
    return canOpenRow(ctx.entry, ctx.displayName, trashView);
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

  function handleOsDrop(event, destPath) {
    event.preventDefault();
    clearSpringLoad();
    setDropTarget(null);
    // Entries only work while the drop event runs, so take them now; the
    // file task store walks the folders later.
    const dropped = takeDropped(event.dataTransfer);
    if (dropped.entries.length || dropped.files.length) {
      haptic("heavy");
      onUploadFiles?.({ dropped }, destPath);
    }
  }

  function onRowDragStart(ctx, event) {
    if (isPicker || !onInternalMove) return;
    const origin = event.target;
    if (origin instanceof Element && origin.closest("[data-no-row-drag]")) {
      event.preventDefault();
      return;
    }
    haptic("rigid");
    const paths = selectedSet.has(ctx.fullPath) && selectedPaths.length
      ? selectedPaths
      : [ctx.fullPath];
    dragPathsRef.current = paths;
    dragIndexRef.current = visibleIndex.get(ctx.fullPath) ?? -1;
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
    const dropped = takeDropped(event.dataTransfer);
    if ((dropped.entries.length || dropped.files.length) && onUploadFiles) {
      onUploadFiles({ dropped }, destFolder);
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

  // Stable handle for the memoized rows. Methods read the latest closure
  // through the ref, so rows never re-render just because a handler changed.
  const latest = useRef(/** @type {any} */ (null));
  latest.current = {
    onShare, onCopy, onMove, onRename, onDelete, onSelect, onOpenFile,
    openEntry, onRowDragStart, setPropertiesCtx, folderDropProps,
    selectedPaths, setSelectedPaths, setLastClicked, toggleOne,
    source, driveId, queryClient,
  };
  const rowApi = useMemo(() => {
    // Folder rows warm the next listing on hover/press so the click lands on
    // cached rows. A short hover-intent delay keeps a fast mouse sweep or a
    // scroll under the pointer from firing a request per row.
    let prefetchTimer = 0;
    return {
    prefetchFolder: (folderPath, immediate) => {
      window.clearTimeout(prefetchTimer);
      const { source: src, driveId: drive, queryClient: qc } = latest.current;
      const run = () => qc.prefetchQuery({
        queryKey: fileListKey(src, drive, folderPath),
        queryFn: ({ signal }) => src.listDir(drive, folderPath, signal),
      });
      if (immediate) run();
      else prefetchTimer = window.setTimeout(run, 60);
    },
    cancelPrefetch: () => window.clearTimeout(prefetchTimer),
    share: (ctx) => latest.current.onShare?.(ctx),
    copy: (paths) => latest.current.onCopy?.(paths),
    move: (paths) => latest.current.onMove?.(paths),
    rename: (ctx) => latest.current.onRename?.(ctx),
    remove: (paths) => latest.current.onDelete?.(paths),
    select: (ctx) => latest.current.onSelect?.(ctx),
    openFile: (ctx) => latest.current.onOpenFile?.(ctx),
    openEntry: (ctx) => latest.current.openEntry(ctx),
    openProperties: (ctx) => latest.current.setPropertiesCtx(ctx),
    dragStart: (ctx, e) => latest.current.onRowDragStart(ctx, e),
    isTrash: (p) => isTrashPath(p),
    folderDragOver: (p, e) => latest.current.folderDropProps(p, p).onDragOver?.(e),
    folderDragLeave: (p, e) => latest.current.folderDropProps(p, p).onDragLeave?.(e),
    folderDrop: (p, e) => latest.current.folderDropProps(p, p).onDrop?.(e),
    checkboxChange: (fullPath, next, shift) => {
      const cur = latest.current;
      if (shift) {
        cur.toggleOne(fullPath, { additive: true, range: true });
        return;
      }
      cur.setSelectedPaths(
        next
          ? [...new Set([...cur.selectedPaths, fullPath])]
          : cur.selectedPaths.filter((p) => p !== fullPath),
      );
      cur.setLastClicked(fullPath);
    },
    };
  }, []);
  useEffect(() => rowApi.cancelPrefetch, [rowApi, driveId, path]);
  // Whether a folder row accepts drops — same gate folderDropProps applies.
  // (The same test without building the handlers: rows mount while scrolling.)
  const rowDropEnabled = (rowPath) => !isPicker && Boolean(onInternalMove || onUploadFiles)
    && (!floored || pathContains(floor, rowPath));

  /**
   * One listing row. Long folders call it from VirtualRowWindow with the
   * virtualizer's measure ref; short ones render every row directly.
   * @param {number} rowIndex
   * @param {((el: Element | null) => void) | undefined} [measureRef]
   * @param {string} [slotKey] the recycled slot VirtualRowWindow gives the row
   */
  const renderRow = (rowIndex, measureRef = undefined, slotKey = undefined) => {
    const entry = visibleEntries[rowIndex];
    const rowPath = visiblePaths[rowIndex];
    return (
      <FileRow
        key={slotKey ?? entry.name}
        entry={entry}
        path={path}
        fullPath={rowPath}
        // Trash and Backups count as the rows above, so the striping stays on
        // the listing's one alternation either way.
        striped={(rowIndex + rowsAboveFiles) % 2 === 1}
        isLast={rowIndex === visibleEntries.length - 1}
        isSelected={selectedSet.has(rowPath)}
        isDrop={dropTarget === rowPath}
        isPicker={isPicker}
        pickerMode={pickerMode}
        pickSelected={isPicker && selectedPath === rowPath}
        pickBlocked={isPicker && Boolean(isPickBlocked?.(rowPath))}
        multiSelect={multiSelect}
        linkNavigation={linkNavigation}
        canDragRow={!isPicker && Boolean(onInternalMove)}
        dropEnabled={rowDropEnabled(rowPath)}
        trashView={trashView}
        driveId={driveId}
        surface={surface}
        dense={dense}
        isSmUp={isSmUp}
        hasShare={Boolean(onShare)}
        hasCopy={Boolean(onCopy)}
        hasMove={Boolean(onMove)}
        hasRename={Boolean(onRename)}
        hasDelete={Boolean(onDelete)}
        enableDownload={enableDownload}
        renderRowActions={renderRowActions}
        renderRowSheetActions={renderRowSheetActions}
        folderHref={folderHref}
        fileHref={fileHref}
        api={rowApi}
        measureRef={measureRef}
        dataIndex={measureRef ? rowIndex : undefined}
        setSize={measureRef ? visibleEntries.length : undefined}
      />
    );
  };

  const padY = dense ? "py-2 min-h-11" : "py-2.5 min-h-12";
  const allSelected = visiblePaths.length > 0 && selectedSet.size >= visibleIndex.size
    && visiblePaths.every((p) => selectedSet.has(p));
  const selectedCount = selectedPaths.length;
  const showSelectionToolbar = !isPicker && multiSelect && selectedCount > 0;
  // The single-item Sharing button: only when exactly one item is selected and
  // the person can at least read it (same rule as the row action — Read shows
  // the item's links, the sheet gates changes).
  const shareTarget = (() => {
    if (selectedCount !== 1 || !onShare) return null;
    const fullPath = selectedPaths[0];
    const name = fullPath.split("/").pop() || fullPath;
    const entry = entryByPath.get(fullPath) || { name, kind: "file" };
    if (!canSeeLinks(entry.caps || "")) return null;
    return { entry, fullPath };
  })();
  // The browse controls (search pill, segmented control, dropdown) are taller
  // than the selection buttons. Remember the browse height and hold it while
  // selecting so the list below doesn't jump on every mode flip.
  const headerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [browseHeaderHeight, setBrowseHeaderHeight] = useState(0);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el || showSelectionToolbar || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => setBrowseHeaderHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showSelectionToolbar, listingForbidden]);
  // The browser background is itself a drop target ("::current") for the
  // folder being browsed — no visible highlight, only the a11y status.
  const currentFolderDrop = dropTarget === "::current";
  // "Move into this folder" chip — only useful while an internal drag is in
  // flight AND at least one dragged item lives outside the folder being
  // browsed. Foreign drags (spring-loaded in from another drive's browser)
  // leave dragPathsRef empty, so they're always treated as from elsewhere.
  const lunaDragFromElsewhere = dragPathsRef.current.length === 0
    || dragPathsRef.current.some((p) => parentPath(p) !== path);
  const showHereDrop = lunaDragActive && !isPicker && Boolean(onInternalMove) && lunaDragFromElsewhere;

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
  // A dragged row can be unmounted by the list window, and a source node that
  // leaves the page never fires dragend. Pointer events do not fire during a
  // drag, so the first one after it means the drag is over.
  useEffect(() => {
    if (!lunaDragActive) {
      dragIndexRef.current = -1;
      return undefined;
    }
    function dragOver() {
      clearSpringLoad();
      setLunaDragActive(false);
      setDropTarget(null);
    }
    window.addEventListener("pointermove", dragOver, { once: true });
    return () => window.removeEventListener("pointermove", dragOver);
  }, [lunaDragActive, clearSpringLoad]);

  const showTrashEntry = Boolean(trashHref && !isPicker && path === "");
  const showBackupsEntry = Boolean(backupsHref && !isPicker && path === "");

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
            aria-label="Add files"
            tabIndex={-1}
            onChange={(e) => {
              const files = filesFromFileList(e.target.files);
              e.target.value = "";
              if (files.length) onUploadFiles?.({ files }, path);
            }}
          />
          {canPickFolder ? (
            <input
              ref={folderPicker}
              type="file"
              multiple
              {...FOLDER_INPUT}
              className="sr-only"
              aria-label="Add a folder"
              tabIndex={-1}
              onChange={(e) => {
                const files = filesFromFileList(e.target.files);
                // Reset so picking the same folder again fires `change` again.
                e.target.value = "";
                if (files.length) {
                  onUploadFiles?.({ files }, path);
                  return;
                }
                // An empty folder (or one holding only empty folders) gives the
                // picker nothing to hand over. Say so instead of doing nothing.
                addToast?.({
                  type: "info",
                  message: "That folder has no files in it.",
                  description: "The folder picker can't copy empty folders. Drag the folder in instead.",
                });
              }}
            />
          ) : null}
          {canPickFolder ? (
            <Dropdown
              menu
              menuLabel="Upload"
              options={UPLOAD_MENU_OPTIONS}
              value=""
              align="end"
              onChange={(choice) => {
                if (choice === "folder") folderPicker.current?.click();
                else filePicker.current?.click();
              }}
              renderTrigger={({ open: isOpen, toggle, onKeyDown }) => (
                <Button
                  variant="outline"
                  surface={surface}
                  size="sm"
                  type="button"
                  haptic={false}
                  aria-haspopup="menu"
                  aria-expanded={isOpen}
                  aria-label="Upload"
                  onClick={() => {
                    haptic("light");
                    toggle();
                  }}
                  onKeyDown={onKeyDown}
                >
                  <UploadCloud size={14} aria-hidden="true" />
                  Upload
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={cn(
                      "motion-safe:transition-transform motion-safe:duration-300",
                      isOpen ? "rotate-180" : "rotate-0",
                    )}
                  />
                </Button>
              )}
            />
          ) : (
            <Button
              variant="outline"
              surface={surface}
              size="sm"
              type="button"
              onClick={() => filePicker.current?.click()}
            >
              <UploadCloud size={14} aria-hidden="true" />
              Upload
            </Button>
          )}
        </>
      ) : null}
    </>
  ) : null;

  // `surface` names what the cards establish. "secondary" (default) is the
  // normal card-on-page look; "primary" is for embedding inside a
  // bg-secondary surface (a modal), where cards take the page color and
  // every interior surface follows — controls name the card they sit on,
  // inset wells flip the pair.
  const well = surface === "primary" ? "secondary" : "primary";
  const fg = surface === "primary" ? "text-secondary" : "text-primary";
  const cardSurface = surface === "primary" ? "surface-primary" : "surface-secondary";
  // Row striping is positional: even rows in the listing wear the card
  // surface, odd rows this fill (FileRow makes the same pick from its
  // `striped` flag). Trash and Backups render as the first rows of the drive
  // root, so they stripe too, and the file rows offset by `rowsAboveFiles` to
  // stay on the listing's one alternation.
  // color-scan: ignore-next-line mixes theme CSS vars only (no hardcoded hex)
  const stripeSurface = surface === "primary"
    ? "bg-[color-mix(in_oklab,var(--primary)_92%,var(--secondary))]"
    : "bg-[color-mix(in_oklab,var(--secondary)_92%,var(--primary))]";
  const rowSurface = (rowIndex) => (rowIndex % 2 === 1 ? stripeSurface : cardSurface);
  const rowsAboveFiles = (showTrashEntry ? 1 : 0) + (showBackupsEntry ? 1 : 0);
  const wellSurface = well === "primary" ? "surface-primary" : "surface-secondary";
  const wellFg = well === "primary" ? "text-secondary" : "text-primary";
  const hairline = surface === "primary" ? "border-secondary" : "border-primary";
  return (
    <div
      className={className}
      data-slot="file-browser"
      onDragOver={(e) => {
        if (isPicker) return;
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
        if (isPicker) return;
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
                  <p className={`text-xs font-mono ${fg} mb-1`}>
                    Current folder
                  </p>
                  <div className={`flex items-center gap-2 font-mono text-sm ${fg}`}>
                    <span>{rootCrumbLabel}</span>
                    {segments.slice(floorSegs.length).map((segment, i) => (
                      <span key={`probe-${segment}-${i}`} className="flex items-center gap-2">
                        <span aria-hidden="true">/</span>
                        <span>{segmentLabel ? segmentLabel(segment, floorSegs.length + i) : segment}</span>
                      </span>
                    ))}
                    {breadcrumbExtra}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  {folderActions}
                  {enableUploadDrop && !isPicker ? (
                    <Button variant="outline" surface={surface} size="sm" type="button" tabIndex={-1}>
                      <UploadCloud size={14} aria-hidden="true" />
                      Upload
                      {canPickFolder ? <ChevronDown size={14} aria-hidden="true" /> : null}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          <Card padding surface={surface}>
            <div
              className={cn(
                "flex items-start gap-3",
                !folderChromeSplit && hasFolderActions && "justify-between",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className={`text-xs font-mono ${fg} mb-1`}>
                  Current folder
                </p>
                <div
                  className={`flex flex-wrap items-center gap-2 font-mono text-sm ${fg}`}
                  aria-live="polite"
                >
                  {(() => {
                    const isRootDrop = dropTarget === "::root";
                    // The root crumb stays a valid target at the drive root
                    // (drags arriving from elsewhere can land there); items
                    // already at root are filtered as no-ops in onFolderDrop.
                    // With a grant floor the crumb is the granted path —
                    // the member's virtual root — and drops land there.
                    const rootDropProps = folderDropProps("::root", rootCrumbPath);

                    // Permanent pill footprint (`px-1` balanced by `-mx-1`)
                    // so the accent ring hugs the rounded crumb without
                    // shifting the rest of the trail when it appears.
                    return linkNavigation ? (
                      <TextLink
                        to={folderHref(driveId, rootCrumbPath)}
                        surface={surface}
                        className={cn(
                          `no-underline hover:underline decoration-accent hover:decoration-accent underline-offset-4 break-all ${fg} rounded-pill px-1 -mx-1`,
                          isRootDrop && "ring-2 ring-accent",
                        )}
                        draggable={false}
                        {...rootDropProps}
                      >
                        {rootCrumbLabel}
                      </TextLink>
                    ) : (
                      <button
                        type="button"
                        {...rootDropProps}
                        className={cn(
                          `${fg} hover:underline decoration-accent underline-offset-4 break-all text-left rounded-pill px-1 -mx-1`,
                          isRootDrop && "ring-2 ring-accent",
                        )}
                        onClick={() => openFolder(rootCrumbPath)}
                      >
                        {rootCrumbLabel}
                      </button>
                    );
                  })()}
                  {segments.slice(floorSegs.length).map((segment, i) => {
                    const segIndex = floorSegs.length + i;
                    const segPath = segments.slice(0, segIndex + 1).join("/");
                    const isSegDrop = dropTarget === `::seg::${segPath}`;
                    // The current (last) segment is a valid target too —
                    // dropping moves items into the folder being browsed;
                    // items already inside it are filtered as no-ops in
                    // onFolderDrop. armSpringLoad already skips `segPath === path`.
                    const segDropProps = folderDropProps(`::seg::${segPath}`, segPath);

                    return (
                      <span key={`${segment}-${i}`} className="flex items-center gap-2 min-w-0">
                        <span className={fg} aria-hidden="true">/</span>
                        {linkNavigation ? (
                          <TextLink
                            to={folderHref(driveId, segPath)}
                            surface={surface}
                            className={cn(
                              `no-underline hover:underline decoration-accent hover:decoration-accent underline-offset-4 break-all ${fg} rounded-pill px-1 -mx-1`,
                              isSegDrop && "ring-2 ring-accent",
                            )}
                            draggable={false}
                            {...segDropProps}
                          >
                            {segmentLabel ? segmentLabel(segment, segIndex) : segment}
                          </TextLink>
                        ) : (
                          <button
                            type="button"
                            {...segDropProps}
                            className={cn(
                              `${fg} hover:underline decoration-accent underline-offset-4 break-all text-left rounded-pill px-1 -mx-1`,
                              isSegDrop && "ring-2 ring-accent",
                            )}
                            onClick={() => openFolder(segPath)}
                          >
                            {segmentLabel ? segmentLabel(segment, segIndex) : segment}
                          </button>
                        )}
                      </span>
                    );
                  })}
                  {listBusy ? (
                    <Spinner size="sm" label="Loading folder" className={fg} />
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
            {(showUpButton && upPath !== null) || headerExtra || hereDropMounted ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {showUpButton && upPath !== null && (() => {
                  const isUpDrop = dropTarget === "::up";
                  const upDropProps = folderDropProps("::up", upPath);

                  return linkNavigation ? (
                    <Button
                      variant="outline"
                      surface={surface}
                      size="sm"
                      asChild
                      className={cn(isUpDrop && "border-transparent ring-2 ring-accent")}
                      {...upDropProps}
                    >
                      <Link to={folderHref(driveId, upPath)} draggable={false}>↑ Up one folder</Link>
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      surface={surface}
                      size="sm"
                      className={cn(isUpDrop && "border-transparent ring-2 ring-accent")}
                      onClick={() => openFolder(upPath)}
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
                      surface={surface}
                      size="sm"
                      smoothResize={false}
                      aria-label="Drop files here to move them into this folder"
                      className={cn(
                        "border-dotted border-accent",
                        hereDropClosing
                          ? "slide-out-to-left-pop animate-out"
                          : "slide-in-from-left-pop animate-in duration-300",
                        isHereDrop && "border-transparent ring-2 ring-accent",
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
            <Card className="mt-3" padding surface={surface}>
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

      <Card
        padding={false}
        className={listClassName}
        aria-busy={listBusy || undefined}
        surface={surface}
      >
        {currentFolderDrop ? (
          <span className="sr-only" role="status">
            Drop to put items in this folder
          </span>
        ) : null}
        {!listingForbidden && (
          <div
            data-slot="file-browser-column-header"
            ref={headerRef}
            style={showSelectionToolbar && browseHeaderHeight ? { minHeight: browseHeaderHeight } : undefined}
            className={`min-h-11 flex flex-wrap items-center gap-2 px-3 py-1 border-b ${hairline}/20 motion-safe:transition-colors ${
              showSelectionToolbar ? "bg-current/10" : ""
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
            {!isPicker && multiSelect ? (
              <AnimatedCheckbox
                checked={allSelected}
                onChange={(next) => (next ? selectAllVisible() : clearSelection())}
                aria-label="Select all in this folder"
                surface={surface}
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
                {/* The count rolls like an odometer: only the digits that
                    change move, the rest of the bar stays put. */}
                <span className="sr-only" role="status">{selectedCount} selected</span>
                <span aria-hidden="true" className={`font-mono text-xs ${fg} shrink-0 whitespace-nowrap`}>
                  <RollingNumber value={selectedCount} /> selected
                </span>
                <Button variant="outline" surface={surface} size="sm" className="shrink-0" onClick={clearSelection}>
                  Clear
                </Button>
                <SlideCollapse show={!!shareTarget}>
                  <Button
                    variant="outline"
                    surface={surface}
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      if (!shareTarget) return;
                      onShare({
                        entry: shareTarget.entry,
                        path,
                        fullPath: shareTarget.fullPath,
                        displayName: displayNameOf(shareTarget.entry),
                      });
                    }}
                  >
                    Sharing
                  </Button>
                </SlideCollapse>
                <SlideCollapse show={selectedCount === 1 && !!enableDownload}>
                  <Button variant="outline" surface={surface} size="sm" className="shrink-0" asChild>
                    <a href={source.downloadHref(driveId, selectedPaths[0] ?? "")}>Download</a>
                  </Button>
                </SlideCollapse>
                {onCopy ? (
                  <Button
                    variant="outline"
                    surface={surface}
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
                    surface={surface}
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
                    surface={surface}
                    size="sm"
                    className="shrink-0"
                    onClick={() => onDelete(selectedPaths)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    {trashView ? "Delete permanently" : "Trash"}
                  </Button>
                ) : null}
                {renderSelectionActions?.(
                  selectedPaths,
                  selectedPaths
                    .map((p) => entryByPath.get(p))
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
                <div className={`flex min-w-36 flex-1 items-center gap-2 rounded-pill border-2 border-transparent ${wellSurface} px-3 py-1 focus-within:border-accent motion-safe:transition-colors`}>
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <Search size={14} className="shrink-0" aria-hidden="true" />
                    <input
                      ref={filterInputRef}
                      type="text"
                      className={`min-w-0 flex-1 appearance-none border-0 bg-transparent text-sm ${wellFg} shadow-none outline-none no-focus-outline`}
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
                      <span className="shrink-0 font-mono text-xs">
                        {visibleEntries.length} of {entries.length}
                      </span>
                    ) : null}
                  </label>
                  {/* Always rendered so the bar keeps its height: the button is
                      taller than the text row. Hidden until there's text, and
                      zero-width then so the counter sits at the pill's edge. */}
                  <div className={`overflow-hidden motion-safe:transition-[max-width,margin,opacity] ${filterText ? "max-w-10 ml-0 opacity-100" : "pointer-events-none max-w-0 -ml-2 opacity-0"}`}>
                    <Button
                      variant="ghost"
                      surface={well}
                      size="iconSm"
                      aria-label="Clear the folder filter"
                      aria-hidden={filterText ? undefined : true}
                      tabIndex={filterText ? undefined : -1}
                      onClick={() => setFilterText("")}
                    >
                      <X size={14} />
                    </Button>
                  </div>
                </div>
                <SegmentedControl
                  surface={surface}
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
                  bg={well}
                  options={SORT_OPTIONS}
                  value={sortKey}
                  onChange={changeSort}
                  aria-label="Sort files"
                />
                <Button
                  variant="ghost"
                  surface={surface}
                  size="iconSm"
                  aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
                  aria-pressed={showHidden}
                  title={showHidden ? "Hide hidden files" : "Show hidden files"}
                  onClick={() => {
                    haptic("light");
                    setShowHidden((prev) => {
                      const next = !prev;
                      try {
                        window.localStorage.setItem(HIDDEN_STORAGE_KEY, next ? "1" : "0");
                      } catch {
                        // Private browsing — the pref just doesn't stick.
                      }
                      return next;
                    });
                  }}
                >
                  {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* A member's 403 is not an error state — the caller's friendly
            "not shared with you" surface explains it and points at Shared. */}
        {listingForbidden ? (
          <div className="px-3 py-5">{forbiddenState}</div>
        ) : listBusy && entries.length === 0 ? (
          stillWorking || <div className="h-11" aria-hidden="true" />
        ) : (
          <>
          {showingStaleListing ? stillWorking : null}
          <ul
            ref={listRef}
            className={[
              "m-0 p-0 list-none flex flex-col motion-safe:transition-opacity motion-safe:duration-200",
              // The next folder is still loading: dim the old rows after a beat
              // (fast loads never flash) so the click visibly registered.
              showingStaleListing ? "pointer-events-none opacity-60 motion-safe:delay-150" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label="Files and folders"
            // The virtualizer corrects scroll itself when rows resize; the
            // browser's own scroll anchoring on top of that made the list wiggle.
            style={{ overflowAnchor: "none" }}
            {...(showingStaleListing ? { inert: true } : {})}
          >
                {showTrashEntry ? (() => {
                  const isTrashDrop = dropTarget === "::trash";
                  // The Trash row is a folder row: it gets the same actions
                  // slot (callers decide which buttons apply) and Properties.
                  const trashCtx = {
                    entry: { name: "Trash", kind: "dir" },
                    path: "",
                    fullPath: TRASH_PATH,
                    displayName: "Trash",
                  };
                  return (
                    <li
                      className={[
                        "flex items-center gap-2 px-3",
                        padY,
                        // Trash is row 0 of the listing: the plain card surface.
                        `${rowSurface(0)} ${fg}`,
                        // One outline: the drop ring replaces the row separator
                        // (border-b kept transparent so the row height doesn't shift).
                        isTrashDrop
                          ? "ring-2 ring-accent ring-inset border-b border-transparent"
                          : "border-b border-primary/15",
                        entries.length > 0 ? "last:border-b-0 last:rounded-b-large-element" : "",
                        "motion-safe:transition-colors",
                      ].filter(Boolean).join(" ")}
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
                        className={`flex items-center gap-2 min-w-0 ${fg} hover:underline`}
                      >
                        <Trash2 size={16} className="shrink-0" aria-hidden="true" />
                        <span className="font-mono text-sm truncate">Trash</span>
                      </Link>
                    ) : (
                      <a
                        href={trashHref}
                        draggable={false}
                        className={`flex items-center gap-2 min-w-0 ${fg} hover:underline`}
                      >
                        <Trash2 size={16} className="shrink-0" aria-hidden="true" />
                        <span className="font-mono text-sm truncate">Trash</span>
                      </a>
                    )}
                  </div>
                  <div
                    data-no-row-drag
                    className="shrink-0 max-w-[40%] sm:max-w-none flex flex-wrap items-center justify-end gap-0.5"
                    draggable={false}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    {renderRowActions?.(trashCtx)}
                    {!isPicker && (
                      <PropertiesButton
                        label="Trash"
                        onClick={() => setPropertiesCtx(trashCtx)}
                        surface={surface}
                      />
                    )}
                  </div>
                </li>
              );
            })() : null}
            {showBackupsEntry ? (
              <li
                className={[
                  "flex items-center gap-2 px-3",
                  padY,
                  // Row 1 when Trash is above it, so this is where the stripe
                  // starts showing; without Trash it leads as row 0.
                  `${rowSurface(showTrashEntry ? 1 : 0)} ${fg}`,
                  "border-b border-primary/15",
                  entries.length > 0 ? "last:border-b-0 last:rounded-b-large-element" : "",
                ].filter(Boolean).join(" ")}
              >
                {!isPicker && multiSelect ? (
                  <span className="w-5 shrink-0" aria-hidden="true" />
                ) : null}
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {linkNavigation ? (
                    <Link
                      to={backupsHref}
                      draggable={false}
                      className={`flex items-center gap-2 min-w-0 ${fg} hover:underline`}
                    >
                      <Archive size={16} className="shrink-0" aria-hidden="true" />
                      <span className="font-mono text-sm truncate">Backups</span>
                    </Link>
                  ) : (
                    <a
                      href={backupsHref}
                      draggable={false}
                      className={`flex items-center gap-2 min-w-0 ${fg} hover:underline`}
                    >
                      <Archive size={16} className="shrink-0" aria-hidden="true" />
                      <span className="font-mono text-sm truncate">Backups</span>
                    </a>
                  )}
                </div>
              </li>
            ) : null}
            {visibleEntries.length > 0 ? (
              <>
                {virtualOn ? (
                  <VirtualRowWindow
                    count={visibleEntries.length}
                    rowKey={rowKey}
                    dense={dense}
                    cardFill={surface === "primary" ? "var(--primary)" : "var(--secondary)"}
                    stripeFill={surface === "primary"
                      ? "color-mix(in oklab, var(--primary) 92%, var(--secondary))"
                      : "color-mix(in oklab, var(--secondary) 92%, var(--primary))"}
                    fullOverscan={fullOverscan}
                    scrollMargin={scrollMargin}
                    dragIndexRef={dragIndexRef}
                    virtualizerRef={virtualizerRef}
                    topSpacerRef={topSpacerRef}
                    renderRow={renderRow}
                  />
                ) : (
                  visibleEntries.map((_, rowIndex) => renderRow(rowIndex))
                )}
              </>
            ) : listing.isError ? (
              <li
                data-slot="listing-error"
                className={`flex flex-col items-center justify-center py-20 px-3 text-center select-none ${fg}`}
              >
                <TriangleAlert size={32} className="mb-3 text-error" aria-hidden="true" />
                <p className="font-mono text-base" role="alert">
                  {folderListingError(listing.error)}
                  {isFolderGone(listing.error) ? (
                    <>
                      {" Use "}
                      <button
                        type="button"
                        className={`${fg} underline decoration-accent underline-offset-2 hover:decoration-current`}
                        onClick={() => {
                          haptic("light");
                          openFileSearch();
                        }}
                      >
                        Universal Search
                      </button>
                      {" to look for it."}
                    </>
                  ) : null}
                </p>
                {isFolderGone(listing.error) ? null : (
                  <Button
                    variant="outline"
                    surface={surface}
                    size="sm"
                    className="mt-4"
                    disabled={listing.isFetching}
                    onClick={() => listing.refetch()}
                  >
                    Try again
                  </Button>
                )}
              </li>
            ) : isFiltered ? (
            <li
              data-slot="empty-state"
              className={`flex flex-col items-center justify-center py-16 px-3 text-center select-none ${fg}`}
            >
              <div className="mb-3">
                <SearchX size={32} aria-hidden="true" />
              </div>
              <p className="font-mono text-base mb-4">
                {filterText.trim()
                  ? `Nothing matches "${filterText.trim()}" in this folder`
                  : kindFilter === "dir"
                    ? "No folders in this folder"
                    : "No files in this folder"}
              </p>
              <Button
                variant="outline"
                surface={surface}
                size="sm"
                onClick={() => {
                  setFilterText("");
                  setKindFilter("all");
                }}
              >
                Show everything
              </Button>
            </li>
          ) : (
            <li
              data-slot="empty-state"
              className={`flex items-center justify-center py-20 px-3 text-center select-none font-mono text-base sm:text-lg ${fg}`}
            >
              {emptyTitle || "There's nothing here."}
            </li>
          )}
        </ul>
          </>
      )}
        {isPicker && pickerMode === "folder" && (
          <div className={`flex flex-wrap items-center gap-2 px-3 py-3 border-t ${hairline}/20`}>
            <p className={`${fg} text-sm flex-1 min-w-0`}>
              Choose a folder, or use the one you are in now.
            </p>
            <Button
              variant={selectedPath === path ? well : "outline"}
              surface={surface}
              size="sm"
              disabled={isTrashPath(path) || Boolean(isPickBlocked?.(path))}
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
        )}
      </Card>

      <PropertiesSheet
        open={propertiesCtx != null}
        driveId={driveId}
        driveLabel={driveLabel}
        path={propertiesCtx?.fullPath || ""}
        parent={propertiesCtx?.path || ""}
        entry={propertiesCtx ? { ...propertiesCtx.entry, name: propertiesCtx.displayName } : null}
        inTrash={isTrashPath(propertiesCtx?.fullPath || "")}
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
  pathFloor: PropTypes.string,
  forbiddenState: PropTypes.node,
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
  renderRowSheetActions: PropTypes.func,
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
  backupsHref: PropTypes.string,
  toolbarExtra: PropTypes.node,
  folderActions: PropTypes.node,
  emptyTitle: PropTypes.string,
  className: PropTypes.string,
  listClassName: PropTypes.string,
  dense: PropTypes.bool,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  isPickBlocked: PropTypes.func,
};
