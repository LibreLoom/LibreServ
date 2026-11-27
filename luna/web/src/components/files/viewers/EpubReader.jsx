import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { ChevronLeft, ChevronRight, List, X } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import {
  bookAuthor,
  bookTitle,
  currentReaderColors,
  flattenToc,
  loadReadingPosition,
  openEpub,
  positionKey,
  progressInfo,
  readerCss,
  saveReadingPosition,
} from "../../../lib/epubReader.js";

const isEditableTarget = (target) =>
  Boolean(target?.closest?.("input, textarea, select, [contenteditable='true'], [role='textbox']"));
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/**
 * Paginated EPUB reader. foliate-js (<foliate-view>) owns rendering —
 * container.xml → OPF → spine order, blob-URL resources, NAV/NCX TOC, CFI
 * positions. This component owns the chrome: title bar, contents drawer,
 * progress, tap zones, keys, swipe, and position memory.
 */
export default function EpubReader({ bytes, driveId, path, fill = false }) {
  const hostRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const viewRef = useRef(/** @type {any} */ (null));
  const touchRef = useRef(/** @type {{ x: number, y: number }|null} */ (null));
  const suppressTapUntil = useRef(0);
  const headingFocus = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const closeContents = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const pageTurn = useRef(/** @type {object|null} */ (null));

  const [phase, setPhase] = useState(/** @type {"loading"|"ready"|"error"} */ ("loading"));
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const [meta, setMeta] = useState({ title: "", author: "" });
  const [coverUrl, setCoverUrl] = useState(/** @type {string|null} */ (null));
  const [toc, setToc] = useState(/** @type {{ label: string, href: string|null, depth: number }[]} */ ([]));
  const [tocOpen, setTocOpen] = useState(false);
  const tocOpenRef = useRef(false);
  const [progress, setProgress] = useState({ percent: 0, label: "" });
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(true);

  const turn = useCallback((dir) => {
    const view = viewRef.current;
    if (!view || pageTurn.current === view || tocOpenRef.current) return;
    const atEdge = dir < 0 ? view.renderer?.atStart : view.renderer?.atEnd;
    if (atEdge) {
      haptic("rigid");
      return;
    }
    haptic("selection");
    pageTurn.current = view;
    Promise.resolve().then(() => {
      if (viewRef.current !== view) return;
      return dir < 0 ? view.goLeft() : view.goRight();
    }).catch(() => {}).finally(() => {
      if (pageTurn.current === view) pageTurn.current = null;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let coverUrlLocal = /** @type {string|null} */ (null);
    let themeObserver = /** @type {MutationObserver|null} */ (null);
    let saveTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
    let pendingPosition = null;
    const savePosition = () => {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (!pendingPosition) return;
      saveReadingPosition(storageKey, pendingPosition);
      pendingPosition = null;
    };
    let ownedView = null;
    let ownedBook = null;
    let opening = false;
    const releaseReader = () => {
      try {
        ownedView?.close?.();
      } catch {
        /* renderer teardown is best-effort */
      } finally {
        ownedView?.remove();
        ownedBook?.destroy?.();
        ownedView = null;
        ownedBook = null;
      }
    };
    const storageKey = positionKey(driveId, path);

    const onKeydown = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target) || tocOpenRef.current) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        turn(-1);
      } else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        turn(1);
      }
    };

    (async () => {
      try {
        const [moduleResult, bookResult] = await Promise.allSettled([
          import("foliate-js/view.js"), openEpub(bytes),
        ]);
        if (bookResult.status === "rejected") throw bookResult.reason;
        const book = bookResult.value;
        ownedBook = book;
        if (moduleResult.status === "rejected") {
          releaseReader();
          throw moduleResult.reason;
        }
        if (cancelled) {
          releaseReader();
          return;
        }

        const view = /** @type {any} */ (document.createElement("foliate-view"));
        ownedView = view;
        viewRef.current = view;
        view.style.display = "block";
        view.style.width = "100%";
        view.style.height = "100%";

        view.addEventListener("relocate", (e) => {
          if (cancelled) return;
          const detail = /** @type {any} */ (e).detail;
          const next = progressInfo(detail);
          setProgress((previous) => previous.percent === next.percent && previous.label === next.label ? previous : next);
          const renderer = view.renderer;
          setCanPrev(!renderer?.atStart);
          setCanNext(!renderer?.atEnd);
          if (detail?.cfi || typeof detail?.fraction === "number") {
            pendingPosition = { cfi: detail.cfi ?? null, fraction: detail.fraction ?? null };
            clearTimeout(saveTimer);
            saveTimer = setTimeout(savePosition, 400);
          }
        });
        // Keys pressed while the book iframe has focus still turn the page.
        view.addEventListener("load", (e) => {
          if (!cancelled) /** @type {any} */ (e).detail?.doc?.addEventListener("keydown", onKeydown);
        });

        hostRef.current?.append(view);
        opening = true;
        try {
          await view.open(book);
        } finally {
          opening = false;
          if (cancelled) releaseReader();
        }
        if (cancelled) return;

        const renderer = view.renderer;
        renderer.setAttribute("flow", "paginated");
        if (!window.matchMedia?.(REDUCED_MOTION).matches) renderer.setAttribute("animated", "");
        let appliedStyles = "";
        const applyTheme = () => {
          if (cancelled) return;
          const styles = readerCss(currentReaderColors());
          if (styles === appliedStyles) return;
          appliedStyles = styles;
          renderer.setStyles?.(styles);
        };
        applyTheme();
        // Re-inject when the app theme flips (the iframe can't see our tokens).
        themeObserver = new MutationObserver(applyTheme);
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });

        setMeta({ title: bookTitle(book.metadata), author: bookAuthor(book.metadata) });
        setToc(flattenToc(book.toc));

        book.getCover?.()
          .then((blob) => {
            if (cancelled || !blob) return;
            coverUrlLocal = URL.createObjectURL(blob);
            setCoverUrl(coverUrlLocal);
          })
          .catch(() => {});

        const saved = loadReadingPosition(storageKey);
        let lastLocation;
        if (saved?.cfi) {
          try {
            if (view.resolveNavigation(saved.cfi)) lastLocation = saved.cfi;
          } catch {
            /* stale CFI from an older copy — fall back to the fraction */
          }
        }
        if (!lastLocation && typeof saved?.fraction === "number" && saved.fraction > 0) {
          lastLocation = { fraction: saved.fraction };
        }
        await view.init({ lastLocation, showTextStart: !lastLocation });
        if (!cancelled) setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        setError(
          "Luna couldn't open this book. It may be damaged or not an EPUB file.",
        );
        setPhase("error");
        console.warn(err);
      }
    })();

    window.addEventListener("keydown", onKeydown);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeydown);
      savePosition();
      if (viewRef.current === ownedView) viewRef.current = null;
      themeObserver?.disconnect();
      if (opening) ownedView?.remove();
      else releaseReader();
      if (coverUrlLocal) URL.revokeObjectURL(coverUrlLocal);
    };
  }, [bytes, driveId, path, turn]);

  // Escape closes the contents drawer before the file modal sees it.
  useEffect(() => {
    if (!tocOpen) return undefined;
    closeContents.current?.focus({ preventScroll: true });
    const onEsc = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        tocOpenRef.current = false;
        setTocOpen(false);
        headingFocus.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [tocOpen]);

  const setDrawer = (open) => {
    tocOpenRef.current = open;
    setTocOpen(open);
    if (!open) headingFocus.current?.focus({ preventScroll: true });
  };

  const goToTocItem = (item) => {
    haptic("selection");
    setDrawer(false);
    if (item.href) void viewRef.current?.goTo(item.href);
  };

  const onTouchStart = (e) => {
    const touch = e.changedTouches[0];
    touchRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (e) => {
    const start = touchRef.current;
    touchRef.current = null;
    const touch = e.changedTouches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      // A swipe started on a tap zone still fires click on release — swallow it.
      suppressTapUntil.current = performance.now() + 350;
      turn(dx < 0 ? 1 : -1);
    }
  };
  const onZoneTap = (dir) => {
    if (performance.now() < suppressTapUntil.current) return;
    turn(dir);
  };

  const surface = fill ? "primary" : "secondary";
  const textTone = fill ? "text-secondary" : "text-primary";

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col gap-3",
        fill ? "h-full" : "h-[65vh]",
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {coverUrl && (
            <img
              src={coverUrl}
              alt=""
              className="h-10 w-8 shrink-0 rounded object-cover"
            />
          )}
          <div className="min-w-0">
            <p className={`truncate font-mono text-sm ${textTone}`}>
              {meta.title || path.split("/").pop()}
            </p>
            {meta.author && (
              <p className={`truncate text-xs ${textTone}`}>{meta.author}</p>
            )}
          </div>
        </div>
        {toc.length > 0 && (
          <Button
            ref={headingFocus}
            variant="outline"
            surface={surface}
            haptic="light"
            onClick={() => setDrawer(true)}
            aria-label="Table of contents"
          >
            <List size={ICON_SIZE.sm} aria-hidden="true" />
            <span className="hidden sm:inline">Contents</span>
          </Button>
        )}
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden rounded-large-element border-2 border-secondary/20 surface-primary"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={() => { touchRef.current = null; }}
      >
        <div ref={hostRef} className="absolute inset-0" />

        {phase === "ready" && (
          <>
            <button
              type="button"
              aria-label="Previous page"
              className="absolute inset-y-0 left-0 z-10 w-[18%] cursor-pointer"
              onClick={() => onZoneTap(-1)}
            />
            <button
              type="button"
              aria-label="Next page"
              className="absolute inset-y-0 right-0 z-10 w-[18%] cursor-pointer"
              onClick={() => onZoneTap(1)}
            />
          </>
        )}

        {phase === "loading" && !error && (
          <div className="absolute inset-0 flex items-center justify-center gap-3 text-secondary">
            <Spinner size="md" decorative />
            <p className="font-mono text-sm">Preparing pages</p>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <p className="text-secondary text-sm">{error}</p>
          </div>
        )}

        {tocOpen && (
          <div
            className="absolute inset-0 z-20 flex justify-end"
            role="presentation"
            onClick={() => setDrawer(false)}
          >
            <div
              className="flex h-full w-72 max-w-[85%] flex-col rounded-large-element border-2 border-secondary/20 surface-secondary"
              role="dialog"
              aria-label="Table of contents"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-center justify-between gap-2 p-3">
                <p className="font-mono text-sm">Contents</p>
                <Button
                  ref={closeContents}
                  variant="ghost"
                  surface="secondary"
                  haptic="light"
                  onClick={() => setDrawer(false)}
                  aria-label="Close contents"
                >
                  <X size={ICON_SIZE.sm} aria-hidden="true" />
                </Button>
              </div>
              <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {toc.map((item, i) => (
                  <li key={`${item.href ?? "item"}-${i}`}>
                    <button
                      type="button"
                      className="w-full rounded-large-element px-3 py-2 text-left text-sm hover:bg-primary hover:text-secondary"
                      style={{ paddingLeft: `${12 + item.depth * 16}px` }}
                      onClick={() => goToTocItem(item)}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <Button
          variant="outline"
          surface={surface}
          haptic="selection"
          disabled={phase !== "ready" || !canPrev}
          onClick={() => turn(-1)}
          aria-label="Previous page"
        >
          <ChevronLeft size={ICON_SIZE.sm} aria-hidden="true" />
          <span className="hidden sm:inline">Previous</span>
        </Button>
        <div className="min-w-0 flex-1">
          <p className={`truncate text-center text-xs ${textTone}`}>
            {progress.label || " "}
          </p>
          <div
            className="mt-1 h-1 w-full overflow-hidden rounded-pill bg-current/20"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            aria-label="Reading progress"
          >
            <div
              className="h-full origin-left rounded-pill bg-current motion-safe:transition-transform duration-300"
              style={{ transform: `scaleX(${progress.percent / 100})` }}
            />
          </div>
          <p className={`mt-1 text-center text-xs ${textTone}`}>
            {progress.percent}%
          </p>
        </div>
        <Button
          variant="outline"
          surface={surface}
          haptic="selection"
          disabled={phase !== "ready" || !canNext}
          onClick={() => turn(1)}
          aria-label="Next page"
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight size={ICON_SIZE.sm} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

EpubReader.propTypes = {
  bytes: PropTypes.any.isRequired,
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  fill: PropTypes.bool,
};
