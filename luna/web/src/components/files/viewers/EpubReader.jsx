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

/**
 * Paginated EPUB reader. foliate-js (<foliate-view>) owns rendering —
 * container.xml → OPF → spine order, blob-URL resources, NAV/NCX TOC, CFI
 * positions. This component owns the chrome: title bar, contents drawer,
 * progress, tap zones, keys, swipe, and position memory.
 */
export default function EpubReader({ bytes, driveId, path, fill = false }) {
  const hostRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const viewRef = useRef(/** @type {any} */ (null));
  const saveTimerRef = useRef(/** @type {ReturnType<typeof setTimeout>|null} */ (null));
  const touchRef = useRef(/** @type {{ x: number, y: number }|null} */ (null));
  const suppressTapRef = useRef(false);

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
    if (!view) return;
    const atEdge = dir < 0 ? view.renderer?.atStart : view.renderer?.atEnd;
    if (atEdge) {
      haptic("rigid");
      return;
    }
    haptic("selection");
    if (dir < 0) void view.goLeft();
    else void view.goRight();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let coverUrlLocal = /** @type {string|null} */ (null);
    let themeObserver = /** @type {MutationObserver|null} */ (null);
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
        const [, book] = await Promise.all([
          import("foliate-js/view.js"),
          openEpub(bytes),
        ]);
        if (cancelled) {
          book.destroy?.();
          return;
        }

        const view = /** @type {any} */ (document.createElement("foliate-view"));
        viewRef.current = view;
        view.style.display = "block";
        view.style.width = "100%";
        view.style.height = "100%";

        view.addEventListener("relocate", (e) => {
          const detail = /** @type {any} */ (e).detail;
          setProgress(progressInfo(detail));
          const renderer = view.renderer;
          setCanPrev(!renderer?.atStart);
          setCanNext(!renderer?.atEnd);
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = setTimeout(() => {
            if (detail?.cfi || typeof detail?.fraction === "number") {
              saveReadingPosition(storageKey, {
                cfi: detail.cfi ?? null,
                fraction: detail.fraction ?? null,
              });
            }
          }, 400);
        });
        // Keys pressed while the book iframe has focus still turn the page.
        view.addEventListener("load", (e) => {
          /** @type {any} */ (e).detail?.doc?.addEventListener("keydown", onKeydown);
        });

        hostRef.current?.append(view);
        await view.open(book);

        const renderer = view.renderer;
        renderer.setAttribute("flow", "paginated");
        renderer.setAttribute("animated", "");
        const applyTheme = () => renderer.setStyles?.(readerCss(currentReaderColors()));
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
          "Luna couldn't open this book. It may be damaged or not a real EPUB file — " +
            "try downloading it and opening it in a reader app on your device.",
        );
        setPhase("error");
        console.warn(err);
      }
    })();

    window.addEventListener("keydown", onKeydown);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeydown);
      clearTimeout(saveTimerRef.current);
      const view = viewRef.current;
      viewRef.current = null;
      try {
        themeObserver?.disconnect();
        view?.close?.();
        view?.book?.destroy?.();
        view?.remove();
      } catch {
        /* renderer teardown is best-effort */
      }
      if (coverUrlLocal) URL.revokeObjectURL(coverUrlLocal);
    };
  }, [bytes, driveId, path, turn]);

  // Escape closes the contents drawer before the file modal sees it.
  useEffect(() => {
    if (!tocOpen) return undefined;
    const onEsc = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setTocOpen(false);
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [tocOpen]);

  const setDrawer = (open) => {
    tocOpenRef.current = open;
    setTocOpen(open);
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
      suppressTapRef.current = true;
      setTimeout(() => {
        suppressTapRef.current = false;
      }, 350);
      turn(dx < 0 ? 1 : -1);
    }
  };
  const onZoneTap = (dir) => {
    if (suppressTapRef.current) return;
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
        className="relative min-h-0 flex-1 overflow-hidden rounded-large-element border-2 border-secondary/20 bg-primary"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
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
            <p className="font-mono text-sm uppercase tracking-widest">Preparing pages</p>
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
              className="flex h-full w-72 max-w-[85%] flex-col rounded-large-element border-2 border-secondary/20 bg-secondary text-primary"
              role="dialog"
              aria-label="Table of contents"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-center justify-between gap-2 p-3">
                <p className="font-mono text-sm uppercase tracking-widest">Contents</p>
                <Button
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
          disabled={!canPrev}
          onClick={() => turn(-1)}
          aria-label="Previous page"
        >
          <ChevronLeft size={ICON_SIZE.sm} aria-hidden="true" />
          <span className="hidden sm:inline">Previous</span>
        </Button>
        <div className="min-w-0 flex-1">
          <p className={`truncate text-center text-xs ${textTone}`}>
            {progress.label || "—"}
          </p>
          <div
            className="mt-1 h-1 w-full overflow-hidden rounded-pill bg-accent/20"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            aria-label="Reading progress"
          >
            <div
              className="h-full rounded-pill bg-accent transition-[width] duration-300"
              style={{ width: `${progress.percent}%` }}
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
          disabled={!canNext}
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
