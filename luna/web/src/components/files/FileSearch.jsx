import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Copy,
  Download,
  File as FileIcon,
  Folder,
  FolderInput,
  FolderOpen,
  Search,
  Trash2,
  X,
} from "lucide-react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import ModalErrorNotice from "@libreloom/ui/components/common/ModalErrorNotice.jsx";
import { showPageLevelError } from "../../lib/modalScopedError";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import DotMatrixLoader from "@libreloom/ui/components/ui/DotMatrixLoader.jsx";
import { ActionTooltipGroup, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import ShareSheet, { ShareButton } from "../share/ShareSheet.jsx";
import FolderPickerModal from "./FolderPickerModal";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { useShortcut } from "@libreloom/ui/context/ShortcutsContext.jsx";
import { OPEN_FILE_SEARCH_EVENT, openFileSearch } from "../../lib/fileSearch.js";
import { apiErrorMessage, getDrives, getJson, postJson } from "../../lib/api";
import { downloadHref as fileDownloadHref, fileHref, parentPath, searchResultHref } from "../../lib/paths";
import { canViewerOpen } from "../../lib/officeConvert.js";
import { capsOnPath, memberFileHref, memberSearchHref } from "../../lib/shareTree.js";
import { CAP } from "../../lib/access.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/** Match ModalCard exit + FLIP morph duration. */
const OVERLAY_EXIT_MS = 320;

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function folderOf(path) {
  return parentPath(path) ?? "";
}

function downloadHref(item) {
  return fileDownloadHref(item.drive_id, item.path);
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

async function parseError(res) {
  try {
    const data = await res.json();
    return data.error || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/**
 * Apply a FLIP invert transform so `el` appears at `fromRect`, then clear it
 * on the next frame so CSS transitions morph to the natural layout.
 * @param {HTMLElement} el
 * @param {DOMRect} fromRect
 * @param {"open" | "close"} direction
 */
function applyFlip(el, fromRect, direction) {
  if (!fromRect || prefersReducedMotion()) return false;
  const to = el.getBoundingClientRect();
  if (to.width < 1 || to.height < 1 || fromRect.width < 1 || fromRect.height < 1) {
    return false;
  }
  const dx = fromRect.left - to.left;
  const dy = fromRect.top - to.top;
  const sx = fromRect.width / to.width;
  const sy = fromRect.height / to.height;
  el.style.transformOrigin = "top left";
  el.style.willChange = "transform, opacity";
  // Keep the panel's final border-radius for the whole FLIP — no pill→card morph.
  if (direction === "open") {
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    el.style.opacity = "0.55";
    // Force layout so the invert sticks before we play forward.
    void el.offsetWidth;
    el.style.transition = [
      "transform var(--motion-duration-medium4) var(--motion-easing-emphasized-decelerate)",
      "opacity var(--motion-duration-medium2) var(--motion-easing-emphasized-decelerate)",
    ].join(", ");
    el.style.transform = "none";
    el.style.opacity = "1";
  } else {
    el.style.transition = [
      "transform var(--motion-duration-medium2) var(--motion-easing-emphasized-accelerate)",
      "opacity var(--motion-duration-short4) var(--motion-easing-emphasized-accelerate)",
    ].join(", ");
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    el.style.opacity = "0";
  }
  return true;
}

/** The header search icon. Opens the all-files search and is where it morphs from. */
export function FileSearchButton() {
  return (
    <span className="inline-flex" data-slot="file-search-trigger">
      <Button
        variant="ghost"
        surface="secondary"
        size="icon"
        aria-label="Search"
        aria-haspopup="dialog"
        aria-keyshortcuts="/"
        onClick={openFileSearch}
      >
        <Search size={20} aria-hidden="true" />
      </Button>
    </span>
  );
}

/**
 * The header search icon on this page. Skips aria-hidden copies — HeaderCard keeps
 * an invisible measuring copy of its buttons pinned to the top left.
 */
function searchTrigger() {
  const all = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-slot="file-search-trigger"]'));
  return [...all].find((el) => !el.closest('[aria-hidden="true"]')) ?? null;
}

/**
 * Universal search across drives — an overlay that morphs out of the header
 * search icon (`FileSearchButton`) when the page has one. Mounted once in
 * AppShell; the button, `/`, and `Alt+/` all open it.
 * Each hit includes the same actions you get on a file row (open, download,
 * share, copy, move, trash) so a match is never just a name you can't use.
 */
export default function FileSearch() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const { user } = useAuth();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [actionError, setActionError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [copyTarget, setCopyTarget] = useState(null);
  const [copyKind, setCopyKind] = useState("copy");
  const [accessTarget, setAccessTarget] = useState(null);

  const [present, setPresent] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const returnFocusRef = useRef(/** @type {HTMLElement | null} */ (null));
  const inputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const panelRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const fromRectRef = useRef(/** @type {DOMRect | null} */ (null));
  const exitTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const isClosingRef = useRef(false);
  const bodyInnerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [bodyHeight, setBodyHeight] = useState(/** @type {number | null} */ (null));

  const focusTrigger = useCallback(() => {
    const button = searchTrigger()?.querySelector("button");
    const target = button || returnFocusRef.current;
    if (target?.isConnected) target.focus();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);

  // `q` is debounced, so also require the live text to be long enough —
  // otherwise old results linger for a moment after the text gets too short.
  const searchActive = q.length >= 2 && typed.trim().length >= 2;

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives, enabled: present });
  const labels = Object.fromEntries((drives.data || []).map((d) => [d.id, d.label]));

  const results = useQuery({
    queryKey: ["search", q],
    queryFn: () => getJson(`/api/v1/search?q=${encodeURIComponent(q)}`),
    enabled: present && !isClosing && q.length >= 2,
  });

  // Member grants make ancestors unbrowsable — a search hit's parent
  // folder can 403, so member links route through memberSearchHref.
  const memberAccess = useQuery({
    queryKey: ["my-access"],
    queryFn: () => getJson("/api/v1/me/access"),
    enabled: present && Boolean(user?.role) && user.role !== "admin",
  });

  const removeMutation = useMutation({
    mutationFn: async (/** @type {any} */ item) => {
      const res = await fetch(
        `/api/v1/drives/${item.drive_id}/files?path=${encodeURIComponent(item.path)}`,
        { method: "DELETE", credentials: "include" }
      );
      if (!res.ok) throw new Error(await parseError(res));
      return res.json();
    },
    onSuccess: () => {
      setActionError(null);
      addToast({ type: "success", message: "Moved to Trash." });
      queryClient.invalidateQueries({ queryKey: ["search"] });
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["trash"] });
    },
    onError: (err) => setActionError(apiErrorMessage(err, "Luna couldn't move that to trash. Try again.")),
  });

  const copyMutation = useMutation({
    mutationFn: async (/** @type {{ driveId: string, path: string }} */ dest) => {
      return postJson("/api/v1/jobs", {
        kind: copyKind,
        from_drive: copyTarget.drive_id,
        from_path: copyTarget.path,
        to_drive: dest.driveId || copyTarget.drive_id,
        to_path: dest.path,
      });
    },
    onSuccess: () => {
      setActionError(null);
      addToast({
        type: "success",
        message: copyKind === "move" ? "Luna is moving that file." : "Luna is copying that file.",
      });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["search"] });
    },
    onError: (err) =>
      setActionError(
        apiErrorMessage(
          err,
          copyKind === "move"
            ? "Luna couldn't start moving that. Try again."
            : "Luna couldn't start copying that. Try again."
        )
      ),
  });

  const actionModalOpen = deleteTarget != null || copyTarget != null || accessTarget != null;

  const finishClose = useCallback(() => {
    if (exitTimerRef.current != null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    setPresent(false);
    setIsClosing(false);
    isClosingRef.current = false;
    if (panelRef.current) {
      panelRef.current.style.transition = "";
      panelRef.current.style.transform = "";
      panelRef.current.style.opacity = "";
      panelRef.current.style.borderRadius = "";
      panelRef.current.style.willChange = "";
    }
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
    setIsClosing(true);

    const trigger = searchTrigger()?.getBoundingClientRect() ?? fromRectRef.current;
    const panel = panelRef.current;
    if (panel && !(trigger && applyFlip(panel, trigger, "close"))) {
      // No header icon to shrink into (e.g. opened from Home): just fade out.
      panel.style.transition = "opacity var(--motion-duration-short4) var(--motion-easing-emphasized-accelerate)";
      panel.style.opacity = "0";
    }

    exitTimerRef.current = setTimeout(() => {
      finishClose();
    }, prefersReducedMotion() ? 0 : OVERLAY_EXIT_MS);
  }, [finishClose, present]);

  const openOverlay = useCallback(() => {
    if (present && !isClosing) return;
    if (exitTimerRef.current != null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    isClosingRef.current = false;
    fromRectRef.current = searchTrigger()?.getBoundingClientRect() ?? null;
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
  // FLIP open: invert from the header button into the elevated search surface.
  useLayoutEffect(() => {
    if (!present || isClosing) return;
    const panel = panelRef.current;
    const from = fromRectRef.current;
    if (!panel) return;
    if (!applyFlip(panel, from, "open")) {
      panel.classList.add("file-search-panel-enter");
    }
  }, [present, isClosing]);

  // Focus the search field once the overlay is up.
  useEffect(() => {
    if (!present || isClosing) return;
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select?.();
    }, prefersReducedMotion() ? 0 : 40);
    return () => window.clearTimeout(id);
  }, [present, isClosing]);

  // Track the results' natural height so the panel glides between states
  // (hint → loading → results) instead of jumping.
  useLayoutEffect(() => {
    const el = bodyInnerRef.current;
    if (!present || !el || typeof ResizeObserver === "undefined") return undefined;
    setBodyHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => setBodyHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [present]);

  // Escape / body scroll lock while the overlay is present.
  useEffect(() => {
    if (!present) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

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
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [present, actionModalOpen, beginClose]);

  useEffect(() => () => {
    if (exitTimerRef.current != null) clearTimeout(exitTimerRef.current);
  }, []);

  const handleInputKeyDown = useCallback((/** @type {import("react").KeyboardEvent<HTMLInputElement>} */ event) => {
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
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

    const allLinks = /** @type {HTMLElement[]} */ ([
      ...(panelRef.current?.querySelectorAll?.('[data-slot="file-search-link"]') ?? []),
    ]);
    if (!allLinks.length) return;

    const currentItem = /** @type {HTMLElement|null} */ (event.target instanceof HTMLElement ? event.target.closest('[data-slot="file-search-item"]') : null);
    const allItems = /** @type {HTMLElement[]} */ ([
      ...(panelRef.current?.querySelectorAll?.('[data-slot="file-search-item"]') ?? []),
    ]);
    const currentIndex = currentItem ? allItems.indexOf(currentItem) : -1;

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
          data-slot="file-search-overlay"
          className={cn(
            "fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 pt-[max(1rem,8vh)] sm:pt-[max(2rem,12vh)]",
            "bg-primary/60 backdrop-blur-sm",
            isClosing
              ? "file-search-backdrop-exit"
              : "file-search-backdrop-enter",
          )}
          onClick={() => {
            if (actionModalOpen) return;
            beginClose();
          }}
        >
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
                    <input
                      ref={inputRef}
                      className="file-search-input flex-1 min-w-0 appearance-none bg-transparent text-secondary text-sm border-0 shadow-none outline-none no-focus-outline"
                      placeholder="Search for a file"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      onKeyDown={handleInputKeyDown}
                      aria-label="Search for a file"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
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
              className="flex-[0_1_auto] min-h-0 overflow-y-auto overscroll-contain motion-safe:transition-[height] motion-safe:duration-300 motion-safe:ease-[var(--motion-easing-emphasized)]"
              style={bodyHeight != null ? { height: bodyHeight } : undefined}
            >
             <div ref={bodyInnerRef} className="px-4 py-3">
              {showPageLevelError(actionError, actionModalOpen) && (
                <PageNotice variant="error" className="mb-3">
                  {actionError}
                </PageNotice>
              )}

              {typed.trim().length > 0 && typed.trim().length < 2 && (
                <p className="text-primary text-sm font-mono py-2">
                  Type at least two characters to search.
                </p>
              )}

              {searchActive && results.isError && (
                <p className="text-error text-xs mb-2">
                  {apiErrorMessage(results.error, "Luna couldn't search right now. Try again.")}
                </p>
              )}

              {searchActive && results.isLoading && (
                <div className="relative mt-1 h-48 overflow-hidden rounded-large-element surface-primary">
                  <DotMatrixLoader label="Searching…" />
                  <span
                    aria-hidden="true"
                    className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-pill surface-secondary px-4 py-1.5 text-sm font-mono"
                  >
                    Searching…
                  </span>
                </div>
              )}

              {searchActive && !results.isLoading && (results.data || []).length === 0 && (
                <EmptyState
                  className="mt-1"
                  surface="primary"
                  title="Nothing matched"
                  description="Try another name, or open a drive and browse. Luna only shows files you're allowed to see."
                />
              )}

              {searchActive && (results.data || []).length > 0 && (
                <ul
                  data-slot="file-search-list"
                  className="grid gap-2"
                  onKeyDown={handleListKeyDown}
                >
                  {results.data.map((item) => {
                    const driveLabel = labels[item.drive_id] || "A drive";
                    const isDir = item.kind === "dir";
                    const href = memberAccess.data
                      ? memberSearchHref(memberAccess.data, item)
                      : searchResultHref(item);
                    // Hits only prove VIEW. Everything else is gated on the
                    // member's real caps — share needs the share bit,
                    // move/trash need edit.
                    const isMember = user?.role !== "admin";
                    const itemCaps = isMember
                      ? capsOnPath(memberAccess.data, item.drive_id, item.path)
                      : CAP.VIEW | CAP.UPLOAD | CAP.EDIT | CAP.SHARE;
                    const canShare = (itemCaps & CAP.SHARE) !== 0;
                    const canEdit = (itemCaps & CAP.EDIT) !== 0;
                    // Openable files open in the viewer on a plain click; the
                    // folder icon still jumps to the file's folder.
                    const opensInViewer = !isDir && canViewerOpen(item.name);
                    const rowHref = opensInViewer
                      ? (memberAccess.data
                        ? memberFileHref(memberAccess.data, item.drive_id, item.path)
                        : fileHref(item.drive_id, item.path))
                      : href;
                    const openLabel = isDir || opensInViewer
                      ? `Open ${item.name}`
                      : `Show ${item.name} in its folder`;
                    const iconOpenLabel = isDir
                      ? `Open ${item.name}`
                      : `Go to folder for ${item.name}`;
                    return (
                      <li key={`${item.drive_id}:${item.path}`} data-slot="file-search-item">
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
                            onClick={() => beginClose("medium")}
                          />
                          <div className="relative z-10 flex items-center gap-2 min-w-0 pointer-events-none">
                            {isDir ? (
                              <Folder size={16} className="shrink-0" aria-hidden="true" />
                            ) : (
                              <FileIcon size={16} className="shrink-0" aria-hidden="true" />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-sm truncate text-secondary">{item.name}</p>
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
                                        beginClose();
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
                                    <a href={downloadHref(item)}>
                                      <Download size={14} />
                                    </a>
                                  </Button>
                                </Tooltip>
                                {canShare && (
                                <ShareButton
                                  label={item.name}
                                  surface="primary"
                                  onClick={() =>
                                    setAccessTarget({
                                      driveId: item.drive_id,
                                      path: item.path,
                                    })
                                  }
                                />
                                )}
                                <Tooltip content="Copy">
                                  <Button
                                    variant="ghost"
                                    surface="primary"
                                    size="iconSm"
                                    aria-label={`Copy ${item.name}`}
                                    onClick={() => {
                                      setCopyKind("copy");
                                      setCopyTarget(item);
                                      setActionError(null);
                                    }}
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
                                    onClick={() => {
                                      setCopyKind("move");
                                      setCopyTarget(item);
                                      setActionError(null);
                                    }}
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
                                    onClick={() => {
                                      setDeleteTarget(item);
                                      setActionError(null);
                                    }}
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
                  })}
                </ul>
              )}

              {typed.trim().length === 0 && (
                <p className="text-primary text-sm py-6 text-center font-mono">
                  Search every file and folder you can open.
                </p>
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
                <span className="font-mono">{deleteTarget?.name}</span> will move to
                Luna&apos;s trash on its drive. You can get it back later from Trash.
              </p>
            </ShakeTarget>
            <ModalErrorNotice error={actionError} />
            <div className="mt-4 flex gap-3">
              <Button
                variant="danger"
                loading={removeMutation.isPending}
                onClick={() => {
                  if (!deleteTarget) return;
                  removeMutation.mutateAsync(deleteTarget)
                    .then(() => close())
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

      <FolderPickerModal
        open={copyTarget != null}
        title={copyKind === "move" ? `Move ${copyTarget?.name || ""}` : `Copy ${copyTarget?.name || ""}`}
        drives={drives.data || []}
        initialDriveId={copyTarget?.drive_id || ""}
        initialPath={copyTarget ? (copyTarget.parent != null ? copyTarget.parent : folderOf(copyTarget.path)) : ""}
        confirmLabel={copyKind === "move" ? "Start moving" : "Start copying"}
        busy={copyMutation.isPending}
        error={copyTarget != null ? actionError : null}
        onClose={() => {
          setActionError(null);
          setCopyTarget(null);
        }}
        onConfirm={(dest, close) => {
          copyMutation.mutateAsync(dest)
            .then(() => close())
            .catch(() => {});
        }}
      />

      <ShareSheet
        open={accessTarget != null}
        subject={
          accessTarget
            ? { kind: "path", driveId: accessTarget.driveId, path: accessTarget.path || "" }
            : null
        }
        onClose={() => setAccessTarget(null)}
      />
    </>
  );
}
