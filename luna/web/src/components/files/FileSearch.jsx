import { Fragment, lazy, startTransition, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import ModalErrorNotice from "@libreloom/ui/components/common/ModalErrorNotice.jsx";
import HoldsPrivateNotice from "./HoldsPrivateNotice.jsx";
import { holdsPrivateOf } from "../../lib/holdsPrivate.js";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import LinearProgress from "@libreloom/ui/components/common/LinearProgress.jsx";
import { showPageLevelError } from "../../lib/modalScopedError";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import FileSearchRow from "./FileSearchRow.jsx";
import { useIsSmUp } from "./fileRowUtils.js";
import { useToneColor } from "@libreloom/ui/lib/iconImage.js";
import FileSearchStatus, { INDEXING_HINT } from "./FileSearchStatus.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { useShortcut } from "@libreloom/ui/context/ShortcutsContext.jsx";
import useFileSearch from "../../hooks/useFileSearch.js";
import {
  MIN_SEARCH_LENGTH,
  OPEN_FILE_SEARCH_EVENT,
  loadSearchKind,
  saveSearchKind,
} from "../../lib/fileSearch.js";
import { apiErrorMessage, deleteJson, getDrives, getJson } from "../../lib/api";
import { parentPath, pathBasename } from "../../lib/paths";
import { isImageFile } from "../../lib/fileKinds.js";
import { perfEndAfterPaint, perfStart } from "../../lib/perf.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { useFileOps } from "../../context/FileOpsContext.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { lockBodyScroll } from "@libreloom/ui/utils/bodyScrollLock.js";

/**
 * Within a group, matches that aren't by name sit under a small heading
 * saying how they matched, so a looser match never passes for a name match.
 * @type {Record<string, string>}
 */
const MATCH_DIVIDERS = {
  content: "Found in the text",
  close: "Similar names",
  meaning: "Close in meaning",
  photo: "Seen in photos",
};

/**
 * A new search paints this many rows first (about what the panel shows) and
 * the rest right after, in an interruptible render: building all ~60 rows
 * before the first paint kept the answer off screen for several hundred ms
 * on Luna's slowest hardware.
 */
const FIRST_ROWS = 12;

/** @type {boolean | null} */
let usualTextSizeSeen = null;
/** Is the page's root text size 16 px (the browser's text size unchanged)? Read once, when first needed. */
function usualTextSize() {
  if (usualTextSizeSeen === null) {
    const px = typeof window === "undefined" ? 16 : Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
    usualTextSizeSeen = !px || px === 16;
  }
  return usualTextSizeSeen;
}

/** Panel exit + backdrop fade (`--motion-duration-short3`), with a frame to spare. */
const OVERLAY_EXIT_MS = 170;

const KIND_OPTIONS = [
  { value: "all", label: "All" },
  { value: "dir", label: "Folders" },
  { value: "file", label: "Files" },
];

function folderOf(path) {
  return parentPath(path) ?? "";
}

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The header search icon on this page. Skips aria-hidden copies — HeaderCard keeps
 * an invisible measuring copy of its buttons pinned to the top left.
 */
function searchTrigger() {
  const all = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-slot="file-search-trigger"]'));
  return [...all].find((el) => !el.closest('[aria-hidden="true"]')) ?? null;
}

// Search is mounted on every page, but these two only open from a hit's
// actions; loading them then keeps them out of the first download.
const ShareSheet = lazy(() => import("../share/ShareSheet.jsx"));
const FolderPickerModal = lazy(() => import("./FolderPickerModal"));

/**
 * Universal search across drives — one overlay on every page. Mounted once in
 * AppShell; the header button, `/`, and `Alt+/` all open it.
 * Each hit includes the same actions you get on a file row (open, download,
 * share, copy, move, trash) so a match is never just a name you can't use.
 */
/** @param {{ initialRequest?: { focus: HTMLElement | null } }} props */
export default function FileSearch({ initialRequest }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const { user } = useAuth();
  const fileOps = useFileOps();
  const [typed, setTyped] = useState("");
  const [kind, setKind] = useState(loadSearchKind);
  const [actionError, setActionErrorText] = useState(null);
  // A delete refused because private items sit inside has its own wording.
  const [actionHold, setActionHold] = useState(null);
  const setActionError = (text) => {
    setActionErrorText(text);
    setActionHold(null);
  };
  const [deleteTarget, setDeleteTarget] = useState(null);
  const deleteTargetRef = useRef(deleteTarget);
  deleteTargetRef.current = deleteTarget;
  const [copyTarget, setCopyTarget] = useState(null);
  const [copyKind, setCopyKind] = useState(/** @type {"copy" | "move"} */ ("copy"));
  const [accessTarget, setAccessTarget] = useState(null);
  // Mounted from the first open on, and kept: they animate their own close.
  const [pickerUsed, setPickerUsed] = useState(false);
  const [shareUsed, setShareUsed] = useState(false);
  if (copyTarget != null && !pickerUsed) setPickerUsed(true);
  if (accessTarget != null && !shareUsed) setShareUsed(true);

  const [present, setPresent] = useState(Boolean(initialRequest));
  const [isClosing, setIsClosing] = useState(false);
  const returnFocusRef = useRef(initialRequest?.focus ?? null);
  const inputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const overlayRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const panelRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const exitTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const isClosingRef = useRef(false);
  const bodyInnerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const bodyScrollRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const focusAfterTrash = useRef(false);

  const focusTrigger = useCallback(() => {
    const button = searchTrigger()?.querySelector("button");
    const target = button || returnFocusRef.current;
    if (target?.isConnected) target.focus();
  }, []);

  const trimmed = typed.trim();
  const search = useFileSearch(trimmed, { enabled: present && !isClosing, kind });

  // W10/W11 (luna/perf): keystroke to rendered results. W10:query starts once
  // the new text has rendered and the quick search goes out;
  // W11 ends only once a "meaning" or "photo" match (neural search) is shown.
  useEffect(() => {
    if (search.active && search.q === trimmed) perfStart("W10:query");
  }, [search.active, search.q, trimmed]);
  const { active: searchActive, q: searchQ, isLoading: searchLoading, isUpdating: searchUpdating, isError: searchFailed, hits: searchHits } = search;
  useEffect(() => {
    if (!searchActive || searchQ !== trimmed || searchLoading || searchUpdating || searchFailed) return;
    perfEndAfterPaint("W10");
    perfEndAfterPaint("W10:query");
    if (searchHits.some((hit) => hit.match === "meaning" || hit.match === "photo")) perfEndAfterPaint("W11");
  }, [typed, trimmed, searchActive, searchQ, searchLoading, searchUpdating, searchFailed, searchHits]);

  const groups = useMemo(() => {
    const best = { label: "Best match", hits: searchHits.slice(0, 1) };
    const folders = { label: "Folders", hits: [] };
    const files = { label: "Files", hits: [] };
    const images = { label: "Image files", hits: [] };
    for (let i = 1; i < searchHits.length; i += 1) {
      const hit = searchHits[i];
      const group = hit.kind === "dir" ? folders : isImageFile(hit.name) ? images : files;
      group.hits.push(hit);
    }
    return [best, folders, files, images].filter((group) => group.hits.length > 0);
  }, [searchHits]);

  // Pace only a fresh search (new text or kind). The full answer and the
  // polls that follow for the same text update rows already on screen.
  const pacingKey = `${kind}\u0000${search.q}`;
  const [paced, setPaced] = useState({ key: "", limit: Infinity });
  const freshAnswer = search.hits.length > FIRST_ROWS && !search.isUpdating && paced.key !== pacingKey;
  if (freshAnswer) setPaced({ key: pacingKey, limit: FIRST_ROWS });
  const rowLimit = freshAnswer ? FIRST_ROWS : paced.limit;
  useEffect(() => {
    if (paced.limit === Infinity) return;
    startTransition(() => setPaced((prev) => ({ ...prev, limit: Infinity })));
  }, [paced]);
  const allRowsShown = rowLimit === Infinity;
  const shownGroups = useMemo(() => {
    if (allRowsShown) return groups;
    let rowsLeft = rowLimit;
    return groups.flatMap((group) => {
      if (rowsLeft === 0) return [];
      const hits = group.hits.slice(0, rowsLeft);
      rowsLeft -= hits.length;
      return [{ ...group, hits }];
    });
  }, [allRowsShown, groups, rowLimit]);
  // Read once for every row: the phone/wide split and the color their
  // action icons' first-paint picture uses. The picture is laid out in px for
  // the usual 16 px text size; any other size mounts the buttons right away.
  const isSmUp = useIsSmUp();
  const toneColor = useToneColor("secondary");
  // Read while the panel opens, not inside the render that paints results.
  useEffect(() => {
    if (present) usualTextSize();
  }, [present]);
  const rowIconColor = search.hits.length > 0 && usualTextSize() ? toneColor : null;

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives, enabled: present });
  const labels = useMemo(() => Object.fromEntries((drives.data || []).map((d) => [d.id, d.label])), [drives.data]);

  // Member grants make ancestors unbrowsable — a search hit's parent
  // folder can 403, so member links route through memberSearchHref.
  const memberAccess = useQuery({
    queryKey: ["my-access"],
    queryFn: ({ signal }) => getJson("/api/v1/me/access", { signal }),
    enabled: present && Boolean(user?.role) && user.role !== "admin",
  });

  const removeMutation = useMutation({
    mutationFn: (/** @type {any} */ item) =>
      deleteJson(
        `/api/v1/drives/${item.drive_id}/files?path=${encodeURIComponent(item.path)}`,
      ),
    onSuccess: (_result, target) => {
      if (deleteTargetRef.current === target) setActionError(null);
      addToast({ type: "success", message: "Moved to Trash." });
      queryClient.invalidateQueries({ queryKey: ["search"] });
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["trash"] });
    },
    onError: (err, target) => {
      if (deleteTargetRef.current !== target) return;
      setActionError(apiErrorMessage(err, "Luna couldn't move that to trash. Try again."));
      setActionHold(holdsPrivateOf(err));
    },
  });

  /** Hand the copy or move to the file task card; it sends, tracks and reports it. */
  function startTransfer(/** @type {{ driveId: string, path: string }} */ dest) {
    if (!copyTarget) return;
    const toDrive = dest.driveId || copyTarget.drive_id;
    fileOps.startJobs({
      kind: copyKind,
      fromDrive: copyTarget.drive_id,
      items: [{ path: copyTarget.path, name: copyTarget.name || pathBasename(copyTarget.path) }],
      toDrive,
      toPath: dest.path,
      toLabel: dest.path ? pathBasename(dest.path) : labels[toDrive] || "",
    });
    setActionError(null);
    queryClient.invalidateQueries({ queryKey: ["search"] });
  }

  const actionModalOpen = deleteTarget != null || copyTarget != null || accessTarget != null;

  const finishClose = useCallback(() => {
    if (exitTimerRef.current != null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    setPresent(false);
    setIsClosing(false);
    isClosingRef.current = false;
    focusTrigger();
  }, [focusTrigger]);

  /** @param {any} [feedback="light"] */
  const beginClose = useCallback((feedback = "light") => {
    if (!present || isClosingRef.current) return;
    if (typeof feedback === "string") {
      haptic(/** @type {any} */ (feedback));
    } else if (feedback !== false && !(feedback && typeof feedback === "object" && "nativeEvent" in feedback)) {
      haptic("light");
    }
    isClosingRef.current = true;
    // The panel and backdrop carry the exit as a CSS animation; see the
    // isClosing classes below.
    setIsClosing(true);

    exitTimerRef.current = setTimeout(() => {
      finishClose();
    }, prefersReducedMotion() ? 0 : OVERLAY_EXIT_MS);
  }, [finishClose, present]);

  // Stable for the memoized result rows: typing re-renders the panel, not
  // every row in the list.
  const shareHit = useCallback(
    (hit) => setAccessTarget({ driveId: hit.drive_id, path: hit.path }),
    [],
  );
  const copyHit = useCallback((copyAs, hit) => {
    setCopyKind(copyAs);
    setCopyTarget(hit);
    setActionError(null);
  }, []);
  const trashHit = useCallback((hit) => {
    setDeleteTarget(hit);
    setActionError(null);
  }, []);

  const openOverlay = useCallback(() => {
    if (present && !isClosing) return;
    if (exitTimerRef.current != null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    isClosingRef.current = false;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIsClosing(false);
    setPresent(true);
    haptic("medium");
  }, [isClosing, present]);

  useEffect(() => {
    window.addEventListener(OPEN_FILE_SEARCH_EVENT, openOverlay);
    return () => window.removeEventListener(OPEN_FILE_SEARCH_EVENT, openOverlay);
  }, [openOverlay]);

  useShortcut(["/", "Alt+/"], openOverlay, { label: "Search all your files", group: "Search" });
  // The panel and backdrop enter animations are held on their first frame
  // until the overlay has painted: the mount is one long task (React, a big
  // page behind it), and an animation started inside it is already part-way
  // through by the first frame. One frame is enough to let the task end.
  useLayoutEffect(() => {
    if (!present || isClosing) return undefined;
    const overlay = overlayRef.current;
    overlay?.classList.remove("file-search-live");
    const id = window.requestAnimationFrame(() => overlay?.classList.add("file-search-live"));
    return () => window.cancelAnimationFrame(id);
  }, [present, isClosing]);

  // The search can take keystrokes on its first frame.
  useLayoutEffect(() => {
    if (!present || isClosing) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [present, isClosing]);

  // Track the results' natural height so the panel glides between states
  // (hint → loading → results) instead of jumping. Before paint, so the first
  // open frame already has this open's height (openOverlay clears the old one).
  useLayoutEffect(() => {
    const el = bodyInnerRef.current;
    const scroll = bodyScrollRef.current;
    if (!present || !el || !scroll || typeof ResizeObserver === "undefined") return undefined;
    scroll.style.height = `${el.offsetHeight}px`;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const height = entry.borderBoxSize?.[0]?.blockSize;
      const next = `${Math.round(height ?? el.offsetHeight)}px`;
      if (scroll.style.height !== next) scroll.style.height = next;
    });
    ro.observe(el, { box: "border-box" });
    return () => ro.disconnect();
  }, [present]);

  useLayoutEffect(() => present ? lockBodyScroll() : undefined, [present]);

  useLayoutEffect(() => {
    if (actionModalOpen || !focusAfterTrash.current) return;
    focusAfterTrash.current = false;
    if (present && !isClosing) inputRef.current?.focus({ preventScroll: true });
  }, [present, isClosing, actionModalOpen]);

  // Escape while the overlay is present.
  useEffect(() => {
    if (!present) return undefined;
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      // Nested action sheets/modals own Escape first.
      if (actionModalOpen) return;
      event.preventDefault();
      event.stopPropagation();
      beginClose();
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [present, actionModalOpen, beginClose]);

  useEffect(() => () => {
    if (exitTimerRef.current != null) clearTimeout(exitTimerRef.current);
  }, []);

  const handleInputKeyDown = useCallback((/** @type {import("react").KeyboardEvent<HTMLInputElement>} */ event) => {
    if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      // Enter opens the best match, like most search boxes.
      const firstLink = panelRef.current?.querySelector?.('[data-slot="file-search-link"]');
      if (firstLink instanceof HTMLElement) {
        event.preventDefault();
        firstLink.click();
      }
      return;
    }
    if (event.key === "ArrowDown" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const firstLink = panelRef.current?.querySelector?.('[data-slot="file-search-link"]');
      if (firstLink instanceof HTMLElement) {
        event.preventDefault();
        firstLink.focus();
        firstLink.scrollIntoView?.({ block: "nearest" });
      }
    }
  }, []);

  const handleListKeyDown = useCallback((/** @type {import("react").KeyboardEvent<HTMLUListElement>} */ event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    // ←/→ move between a row's link and its action buttons.
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const item = target?.closest?.('[data-slot="file-search-item"]');
      if (!target || !item) return;
      const stops = /** @type {HTMLElement[]} */ ([
        ...item.querySelectorAll('[data-slot="file-search-link"], [data-slot="file-search-actions"] a, [data-slot="file-search-actions"] button'),
      ]);
      const at = stops.indexOf(target);
      if (at < 0) return;
      const next = stops[at + (event.key === "ArrowRight" ? 1 : -1)];
      if (next) {
        event.preventDefault();
        next.focus();
      }
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      const links = /** @type {HTMLElement[]} */ ([
        ...(panelRef.current?.querySelectorAll?.('[data-slot="file-search-link"]') ?? []),
      ]);
      const edge = event.key === "Home" ? links[0] : links[links.length - 1];
      if (edge) {
        event.preventDefault();
        edge.focus();
        edge.scrollIntoView?.({ block: "nearest" });
      }
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

    const allLinks = /** @type {HTMLElement[]} */ ([
      ...(panelRef.current?.querySelectorAll?.('[data-slot="file-search-link"]') ?? []),
    ]);
    if (!allLinks.length) return;

    const currentItem = /** @type {HTMLElement|null} */ (event.target instanceof HTMLElement ? event.target.closest('[data-slot="file-search-item"]') : null);
    const currentIndex = currentItem
      ? allLinks.findIndex((link) => currentItem.contains(link)) : -1;

    if (event.key === "ArrowDown") {
      if (currentIndex >= 0 && currentIndex < allLinks.length - 1) {
        event.preventDefault();
        const nextLink = allLinks[currentIndex + 1];
        nextLink?.focus();
        nextLink?.scrollIntoView?.({ block: "nearest" });
      } else if (currentIndex === allLinks.length - 1) {
        event.preventDefault();
      }
    } else if (event.key === "ArrowUp") {
      if (currentIndex > 0) {
        event.preventDefault();
        const prevLink = allLinks[currentIndex - 1];
        prevLink?.focus();
        prevLink?.scrollIntoView?.({ block: "nearest" });
      } else if (currentIndex === 0 || currentIndex === -1) {
        event.preventDefault();
        inputRef.current?.focus();
        const len = inputRef.current?.value?.length ?? 0;
        inputRef.current?.setSelectionRange?.(len, len);
      }
    }
  }, []);

  const overlay = present
    ? createPortal(
        <div
          ref={overlayRef}
          data-slot="file-search-overlay"
          className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 pt-[max(1rem,8vh)] sm:pt-[max(2rem,12vh)]"
          onClick={() => {
            if (actionModalOpen) return;
            beginClose();
          }}
        >
          {/*
            The blur is its own layer, and both backdrops only change opacity.
            A backdrop-filter that changes shape re-blurs the whole page every
            frame (see ModalCard); nesting the animating panel inside it made
            the open/close stutter.
          */}
          <div
            aria-hidden="true"
            data-slot="file-search-blur"
            className={cn(
              "absolute inset-0 -z-10 backdrop-blur-sm",
              isClosing ? "file-search-backdrop-exit" : "file-search-backdrop-enter",
            )}
          />
          <div
            aria-hidden="true"
            data-slot="file-search-scrim"
            className={cn(
              "absolute inset-0 -z-10 bg-primary/60",
              isClosing ? "file-search-backdrop-exit" : "file-search-backdrop-enter",
            )}
          />
          <div
            ref={panelRef}
            data-slot="file-search-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Search for a file"
            className={cn(
              "w-full max-w-2xl max-h-[min(80dvh,40rem)] flex flex-col",
              "rounded-large-element surface-secondary",
              "border border-primary/30 shadow-lg",
              "overflow-hidden",
              isClosing ? "file-search-panel-exit" : "file-search-panel-enter",
            )}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 pt-4 pb-3 shrink-0 border-b border-primary/20">
              <ShakeTarget
                shake={showPageLevelError(actionError, actionModalOpen) ? actionError : null}
                className="min-w-0 flex-1"
              >
                <label className="block min-w-0">
                  <span className="sr-only">Search for a file</span>
                  <span className="flex items-center gap-3 rounded-pill surface-primary border-2 border-transparent px-4 py-2.5 focus-within:border-accent motion-safe:transition-colors">
                    <Search size={18} className="shrink-0" aria-hidden="true" />
                    <span className="flex-1 min-w-0">
                      <input
                        ref={inputRef}
                        className="file-search-input w-full min-w-0 appearance-none bg-transparent text-secondary text-sm border-0 shadow-none outline-none no-focus-outline"
                        placeholder="A name, or words inside a file"
                        value={typed}
                        onChange={(e) => {
                          perfStart("W10");
                          perfStart("W11");
                          setTyped(e.target.value);
                        }}
                        onKeyDown={handleInputKeyDown}
                        aria-label="Search for a file"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </span>
                  </span>
                </label>
              </ShakeTarget>
              <Button
                variant="ghost"
                surface="secondary"
                size="icon"
                aria-label="Close search"
                onClick={beginClose}
              >
                <X size={20} aria-hidden="true" />
              </Button>
            </div>

            <div
              data-slot="file-search-toolbar"
              className="relative flex flex-wrap items-center justify-between gap-2 px-4 py-2 shrink-0 border-b border-primary/20"
            >
              {/* The old list stays up while a new answer loads; this says so. */}
              <LinearProgress
                active={search.isUpdating}
                delayMs={150}
                surface="secondary"
                label="Updating results"
                className="absolute inset-x-0 bottom-0 rounded-none"
              />
              <SegmentedControl
                surface="secondary"
                aria-label="Show"
                options={KIND_OPTIONS}
                value={kind}
                onChange={(next) => {
                  setKind(/** @type {any} */ (next));
                  saveSearchKind(/** @type {any} */ (next));
                }}
              />
              <FileSearchStatus scan={search.scan} />
            </div>

            <div
              ref={bodyScrollRef}
              className="flex-[0_1_auto] min-h-0 overflow-y-auto overscroll-contain motion-safe:transition-[height] motion-safe:duration-150 motion-safe:ease-[var(--motion-easing-emphasized)]"
            >
             <div ref={bodyInnerRef} className="px-4 py-3">
              {showPageLevelError(actionError, actionModalOpen) && (
                <PageNotice variant="error" className="mb-3">
                  {actionError}
                </PageNotice>
              )}

              {trimmed.length > 0 && trimmed.length < MIN_SEARCH_LENGTH && (
                <p className="text-primary text-sm font-mono py-2">
                  Type at least two characters to search.
                </p>
              )}

              {search.isError && (
                <PageNotice variant="error" className="mb-3">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    {apiErrorMessage(search.error, "Luna couldn't search right now.")}
                    <Button variant="outline" surface="primary" size="sm" onClick={() => search.retry()}>
                      Try again
                    </Button>
                  </span>
                </PageNotice>
              )}

              {search.searching && search.hits.length === 0 && <SearchSkeleton />}

              {search.incomplete && !search.isError && !search.isUpdating && trimmed === search.q && (
                <PageNotice variant="warning" className="mb-3">
                  Luna could not check every match or drive. Try again, or type more words.
                </PageNotice>
              )}

              {search.active && !search.searching && !search.isError && !search.incomplete && search.hits.length === 0 && (
                search.scan?.scanning || search.scan?.contents_reading ? (
                  <EmptyState
                    className="mt-1"
                    surface="primary"
                    title="Nothing yet"
                    description={search.scan?.scanning
                      ? "Luna is still reading your drives. Matches appear here as they're found."
                      : (
                        <>
                          Luna is still <TermHint surface="primary" content={INDEXING_HINT}>indexing</TermHint> your files. Matches appear here as they're found.
                        </>
                      )}
                  />
                ) : (
                  <EmptyState
                    className="mt-1"
                    surface="primary"
                    title="Nothing matched"
                    description="Try other words, or open a drive and browse. Luna shows only the files you can open."
                  />
                )
              )}

              {search.hits.length > 0 && (
                <>
                  {search.closeOnly && (
                    <p className="px-1 pb-2 text-sm font-mono text-primary">
                      Nothing matched exactly. These names are close.
                    </p>
                  )}
                  <ul
                    data-slot="file-search-list"
                    aria-busy={search.isUpdating || undefined}
                    className="grid grid-cols-[minmax(0,1fr)] gap-2"
                    onKeyDown={handleListKeyDown}
                  >
                    {shownGroups.map((group) => (
                      <Fragment key={group.label}>
                        <li role="presentation" className="px-1 pt-2 text-xs font-mono text-primary">
                          {group.label}
                        </li>
                        {group.hits.map((item, index) => (
                          <Fragment key={`${item.drive_id}:${item.path}`}>
                            {!(search.closeOnly && item.match === "close")
                              && MATCH_DIVIDERS[item.match]
                              && group.hits[index - 1]?.match !== item.match && (
                              <li role="presentation" className="file-search-row-enter px-1 pt-2 text-xs font-mono text-primary">
                                {MATCH_DIVIDERS[item.match]}
                              </li>
                            )}
                            <FileSearchRow
                              item={item}
                              query={search.resultQ}
                              driveLabel={labels[item.drive_id] || "A drive"}
                              isAdmin={user?.role === "admin"}
                              memberAccess={memberAccess.data}
                              index={index}
                              isSmUp={isSmUp}
                              iconColor={rowIconColor}
                              // A fresh long answer paints its first rows with
                              // pictures of their action icons; the buttons
                              // mount with the rest of the rows.
                              actionsLive={allRowsShown}
                              onNavigate={beginClose}
                              onShare={shareHit}
                              onCopy={copyHit}
                              onTrash={trashHit}
                            />
                          </Fragment>
                        ))}
                      </Fragment>
                    ))}
                  </ul>
                  {search.truncated && allRowsShown && !search.incomplete && !search.isUpdating && trimmed === search.q && (
                    <p data-slot="file-search-truncated" className="px-1 pt-3 text-xs font-mono text-primary">
                      There are more matches than fit here. Type more words to narrow it down.
                    </p>
                  )}
                </>
              )}

              {trimmed.length === 0 && (
                <div className="py-6 text-center font-mono text-primary">
                  <p className="block text-sm">Search every file and folder you can open.</p>
                  <p className="mt-2 text-xs">Press / on any page to open search.</p>
                </div>
              )}
             </div>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      {overlay}

      <ModalCard
        open={deleteTarget != null}
        title="Move to trash?"
        onClose={() => {
          setActionError(null);
          setDeleteTarget(null);
        }}
      >
        {({ close }) => (
          <>
            <ShakeTarget shake={actionError}>
              <p className="text-primary text-sm">
                <InlinePill>{deleteTarget?.name}</InlinePill> will move to
                Luna&apos;s trash on its drive. You can get it back later from Trash.
              </p>
            </ShakeTarget>
            {actionHold
              ? <HoldsPrivateNotice hold={actionHold} />
              : <ModalErrorNotice error={actionError} />}
            <div className="mt-4 flex gap-3">
              <Button
                variant="danger"
                loading={removeMutation.isPending}
                onClick={() => {
                  const target = deleteTarget;
                  if (!target) return;
                  removeMutation.mutateAsync(target)
                    .then(() => {
                      if (deleteTargetRef.current !== target) return;
                      focusAfterTrash.current = true;
                      close();
                    })
                    .catch(() => {});
                }}
              >
                Move to trash
              </Button>
              <Button variant="outline" onClick={close}>
                Keep it
              </Button>
            </div>
          </>
        )}
      </ModalCard>

      {pickerUsed && (
        <Suspense fallback={null}>
          <FolderPickerModal
            open={copyTarget != null}
            title={copyKind === "move" ? `Move ${copyTarget?.name || ""}` : `Copy ${copyTarget?.name || ""}`}
            drives={drives.data || []}
            initialDriveId={copyTarget?.drive_id || ""}
            initialPath={copyTarget ? (copyTarget.parent != null ? copyTarget.parent : folderOf(copyTarget.path)) : ""}
            movingPaths={copyKind === "move" && copyTarget ? [copyTarget.path] : []}
            confirmLabel={copyKind === "move" ? "Start moving" : "Start copying"}
            error={copyTarget != null ? actionError : null}
            onClose={() => {
              setActionError(null);
              setCopyTarget(null);
            }}
            onConfirm={(dest, close) => {
              startTransfer(dest);
              close();
            }}
          />
        </Suspense>
      )}

      {shareUsed && (
        <Suspense fallback={null}>
          <ShareSheet
            open={accessTarget != null}
            subject={
              accessTarget
                ? { kind: "path", driveId: accessTarget.driveId, path: accessTarget.path || "" }
                : null
            }
            onClose={() => setAccessTarget(null)}
          />
        </Suspense>
      )}
    </>
  );
}

/** Placeholder rows while the first answer for a search is on its way. */
function SearchSkeleton() {
  return (
    <div role="status" aria-label="Searching…" className="grid gap-2 mt-1">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          aria-hidden="true"
          className="h-12 rounded-large-element surface-primary motion-safe:animate-pulse"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}
