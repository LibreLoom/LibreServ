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
import Card from "../cards/Card";
import ModalCard from "../cards/ModalCard";
import EmptyState from "../common/EmptyState";
import PageNotice from "../common/PageNotice";
import ModalErrorNotice from "../common/ModalErrorNotice";
import { showPageLevelError } from "../../lib/modalScopedError";
import ShakeTarget from "../ui/ShakeTarget";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner.jsx";
import { ActionTooltipGroup, Tooltip } from "../ui/Tooltip.jsx";
import AccessSheet, { AccessButton } from "./AccessSheet";
import FolderPickerModal from "./FolderPickerModal";
import { apiErrorMessage, getDrives, getJson, postJson } from "../../lib/api";
import { cn } from "@/lib/utils";
import { haptic } from "../../utils/haptics";

/** Match ModalCard exit + FLIP morph duration. */
const OVERLAY_EXIT_MS = 320;

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function folderOf(path) {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

function openHref(item) {
  if (item.kind === "dir") {
    return item.path
      ? `/drives/${item.drive_id}?path=${encodeURIComponent(item.path)}`
      : `/drives/${item.drive_id}`;
  }
  const folder = item.parent != null ? item.parent : folderOf(item.path);
  if (!folder) return `/drives/${item.drive_id}`;
  return `/drives/${item.drive_id}?path=${encodeURIComponent(folder)}`;
}

function downloadHref(item) {
  return `/api/v1/drives/${item.drive_id}/files/content?path=${encodeURIComponent(item.path)}&download=1`;
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
  if (direction === "open") {
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    el.style.opacity = "0.55";
    el.style.borderRadius = "9999px";
    // Force layout so the invert sticks before we play forward.
    void el.offsetWidth;
    el.style.transition = [
      "transform var(--motion-duration-medium4) var(--motion-easing-emphasized-decelerate)",
      "opacity var(--motion-duration-medium2) var(--motion-easing-emphasized-decelerate)",
      "border-radius var(--motion-duration-medium4) var(--motion-easing-emphasized-decelerate)",
    ].join(", ");
    el.style.transform = "none";
    el.style.opacity = "1";
    el.style.borderRadius = "";
  } else {
    el.style.transition = [
      "transform var(--motion-duration-medium2) var(--motion-easing-emphasized-accelerate)",
      "opacity var(--motion-duration-short4) var(--motion-easing-emphasized-accelerate)",
      "border-radius var(--motion-duration-medium2) var(--motion-easing-emphasized-accelerate)",
    ].join(", ");
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    el.style.opacity = "0";
    el.style.borderRadius = "9999px";
  }
  return true;
}

/**
 * Universal search across drives — header icon that morphs into an overlay.
 * Each hit includes the same actions you get on a file row (open, download,
 * share, copy, move, trash) so a match is never just a name you can't use.
 */
export default function FileSearch() {
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [actionError, setActionError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [copyTarget, setCopyTarget] = useState(null);
  const [copyKind, setCopyKind] = useState("copy");
  const [accessTarget, setAccessTarget] = useState(null);

  const [present, setPresent] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const triggerWrapRef = useRef(/** @type {HTMLSpanElement | null} */ (null));
  const inputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const panelRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const fromRectRef = useRef(/** @type {DOMRect | null} */ (null));
  const exitTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const isClosingRef = useRef(false);

  const focusTrigger = useCallback(() => {
    const button = triggerWrapRef.current?.querySelector("button");
    button?.focus();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const labels = Object.fromEntries((drives.data || []).map((d) => [d.id, d.label]));

  const results = useQuery({
    queryKey: ["search", q],
    queryFn: () => getJson(`/api/v1/search?q=${encodeURIComponent(q)}`),
    enabled: present && !isClosing && q.length >= 2,
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

  const beginClose = useCallback(() => {
    if (!present || isClosingRef.current) return;
    haptic("light");
    isClosingRef.current = true;
    setIsClosing(true);

    const trigger = triggerWrapRef.current?.getBoundingClientRect() ?? fromRectRef.current;
    const panel = panelRef.current;
    if (panel && trigger) {
      applyFlip(panel, trigger, "close");
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
    fromRectRef.current = triggerWrapRef.current?.getBoundingClientRect() ?? null;
    setIsClosing(false);
    setPresent(true);
    haptic("medium");
  }, [isClosing, present]);

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
              "rounded-large-element bg-secondary text-primary",
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
                  <span className="flex items-center gap-3 rounded-pill bg-primary text-secondary border-2 border-transparent px-4 py-2.5 focus-within:border-accent motion-safe:transition-colors">
                    <Search size={18} className="text-accent shrink-0" aria-hidden="true" />
                    <input
                      ref={inputRef}
                      className="file-search-input flex-1 min-w-0 appearance-none bg-transparent text-secondary text-sm border-0 shadow-none outline-none no-focus-outline placeholder:text-accent"
                      placeholder="Search for a file"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
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

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-3">
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

              {q.length >= 2 && results.isError && (
                <p className="text-error text-xs mb-2">
                  {apiErrorMessage(results.error, "Luna couldn't search right now. Try again.")}
                </p>
              )}

              {q.length >= 2 && results.isLoading && (
                <Card surface="primary" className="mt-1">
                  <div
                    className="flex items-center justify-center gap-3 py-4 text-secondary"
                    role="status"
                    aria-live="polite"
                  >
                    <p className="text-sm font-mono text-secondary">Searching…</p>
                    <Spinner size="lg" decorative className="text-secondary" />
                  </div>
                </Card>
              )}

              {q.length >= 2 && !results.isLoading && (results.data || []).length === 0 && (
                <EmptyState
                  className="mt-1"
                  surface="primary"
                  title="Nothing matched"
                  description="Try another name, or open a drive and browse. Luna only shows files you're allowed to see."
                />
              )}

              {(results.data || []).length > 0 && (
                <ul className="grid gap-2">
                  {results.data.map((item) => {
                    const driveLabel = labels[item.drive_id] || "A drive";
                    const isDir = item.kind === "dir";
                    return (
                      <li key={`${item.drive_id}:${item.path}`}>
                        <div className="rounded-large-element bg-primary text-secondary px-3 py-2 motion-safe:transition-shadow hover:ring-2 hover:ring-accent">
                          <div className="flex items-center gap-2 min-w-0">
                            {isDir ? (
                              <Folder size={16} className="text-accent shrink-0" aria-hidden="true" />
                            ) : (
                              <FileIcon size={16} className="text-accent shrink-0" aria-hidden="true" />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-sm truncate text-secondary">{item.name}</p>
                              <p className="text-xs truncate text-secondary">
                                {locationLabel(item, driveLabel)}
                                {!isDir && item.size != null ? ` · ${fmtSize(item.size)}` : ""}
                              </p>
                            </div>
                            <ActionTooltipGroup>
                              <div className="flex items-center gap-1 shrink-0">
                                <Tooltip content={isDir ? "Open" : "Go to folder"}>
                                  <Button
                                    variant="ghost"
                                    surface="primary"
                                    size="iconSm"
                                    asChild
                                    aria-label={isDir ? `Open ${item.name}` : `Go to folder for ${item.name}`}
                                  >
                                    <Link to={openHref(item)} onClick={beginClose}>
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
                                <AccessButton
                                  label={item.name}
                                  surface="primary"
                                  onClick={() =>
                                    setAccessTarget({
                                      driveId: item.drive_id,
                                      path: item.path,
                                      kind: isDir ? "folder" : "file",
                                    })
                                  }
                                />
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
                  Search across every drive you can open.
                </p>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div data-slot="file-search" className="inline-flex">
      <span ref={triggerWrapRef} className="inline-flex" data-slot="file-search-trigger">
        <Button
          variant="ghost"
          surface="secondary"
          size="icon"
          aria-label="Search"
          title="Search for a file"
          aria-haspopup="dialog"
          aria-expanded={present && !isClosing}
          onClick={openOverlay}
        >
          <Search size={20} aria-hidden="true" />
        </Button>
      </span>

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

      <AccessSheet
        open={accessTarget != null}
        driveId={accessTarget?.driveId || ""}
        path={accessTarget?.path || ""}
        kind={accessTarget?.kind || "folder"}
        onClose={() => setAccessTarget(null)}
      />
    </div>
  );
}
