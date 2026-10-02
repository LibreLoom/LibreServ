import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import ModalErrorNotice from "@libreloom/ui/components/common/ModalErrorNotice.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import LinearProgress from "@libreloom/ui/components/common/LinearProgress.jsx";
import { showPageLevelError } from "../../lib/modalScopedError";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Typewriter from "@libreloom/ui/components/ui/Typewriter.jsx";
import ShareSheet from "../share/ShareSheet.jsx";
import FolderPickerModal from "./FolderPickerModal";
import FileSearchRow from "./FileSearchRow.jsx";
import FileSearchStatus from "./FileSearchStatus.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { useShortcut } from "@libreloom/ui/context/ShortcutsContext.jsx";
import useFileSearch from "../../hooks/useFileSearch.js";
import {
  MIN_SEARCH_LENGTH,
  OPEN_FILE_SEARCH_EVENT,
  loadSearchKind,
  openFileSearch,
  saveSearchKind,
} from "../../lib/fileSearch.js";
import { apiErrorMessage, getDrives, getJson, postJson } from "../../lib/api";
import { parentPath } from "../../lib/paths";
import { useAuth } from "../../context/AuthContext.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/** Match ModalCard exit + FLIP morph duration. */
const OVERLAY_EXIT_MS = 320;

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
  const [kind, setKind] = useState(loadSearchKind);
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

  const trimmed = typed.trim();
  const search = useFileSearch(trimmed, { enabled: present && !isClosing, kind });

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives, enabled: present });
  const labels = Object.fromEntries((drives.data || []).map((d) => [d.id, d.label]));

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
      // The row is gone; keep the keyboard in the list's search box.
      window.setTimeout(() => inputRef.current?.focus(), 0);
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
                    <span className="flex-1 min-w-0">
                      <input
                        ref={inputRef}
                        className="file-search-input w-full min-w-0 appearance-none bg-transparent text-secondary text-sm border-0 shadow-none outline-none no-focus-outline placeholder:font-mono placeholder:text-secondary"
                        placeholder="A filename, please."
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
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
              className="flex-[0_1_auto] min-h-0 overflow-y-auto overscroll-contain motion-safe:transition-[height] motion-safe:duration-300 motion-safe:ease-[var(--motion-easing-emphasized)]"
              style={bodyHeight != null ? { height: bodyHeight } : undefined}
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

              {search.isLoading && <SearchSkeleton />}

              {search.active && !search.isLoading && !search.isError && search.hits.length === 0 && (
                search.scan?.scanning ? (
                  <EmptyState
                    className="mt-1"
                    surface="primary"
                    title="Nothing yet"
                    description="Luna is still reading your drives. Matches appear here as they're found."
                  />
                ) : (
                  <EmptyState
                    className="mt-1"
                    surface="primary"
                    title="Nothing matched"
                    description="Try another name, or open a drive and browse. Luna only shows files you're allowed to see."
                  />
                )
              )}

              {search.hits.length > 0 && (
                <>
                  {search.closeOnly && (
                    <Typewriter
                      as="p"
                      className="px-1 pb-2 text-sm font-mono text-primary"
                      text="Nothing matched exactly. These names are close."
                      cursor={false}
                    />
                  )}
                  <ul
                    data-slot="file-search-list"
                    aria-busy={search.isUpdating || undefined}
                    className="grid gap-2"
                    onKeyDown={handleListKeyDown}
                  >
                    {search.hits.map((item, index) => (
                      <Fragment key={`${item.drive_id}:${item.path}`}>
                        {!search.closeOnly && item.match === "close" && search.hits[index - 1]?.match !== "close" && (
                          <li
                            role="presentation"
                            className="file-search-row-enter px-1 pt-2 text-xs font-mono text-primary"
                          >
                            Similar names
                          </li>
                        )}
                        <FileSearchRow
                          item={item}
                          query={search.q}
                          driveLabel={labels[item.drive_id] || "A drive"}
                          isAdmin={user?.role === "admin"}
                          memberAccess={memberAccess.data}
                          index={index}
                          onNavigate={beginClose}
                          onShare={(hit) =>
                            setAccessTarget({ driveId: hit.drive_id, path: hit.path })
                          }
                          onCopy={(copyAs, hit) => {
                            setCopyKind(copyAs);
                            setCopyTarget(hit);
                            setActionError(null);
                          }}
                          onTrash={(hit) => {
                            setDeleteTarget(hit);
                            setActionError(null);
                          }}
                        />
                      </Fragment>
                    ))}
                  </ul>
                  {search.truncated && (
                    <p data-slot="file-search-truncated" className="px-1 pt-3 text-xs font-mono text-primary">
                      There are more matches than fit here. Type more of the name to narrow it down.
                    </p>
                  )}
                </>
              )}

              {trimmed.length === 0 && (
                <div className="py-6 text-center font-mono text-primary">
                  <Typewriter
                    as="p"
                    className="block text-sm"
                    text="Search every file and folder you can open."
                    cursor={false}
                  />
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
