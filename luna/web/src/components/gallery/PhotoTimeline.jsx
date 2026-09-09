/* eslint-disable react-refresh/only-export-components -- timeline exports grouping helpers used by GalleryPage and tests */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { ChevronDown, ChevronRight } from "lucide-react";
import Spinner from "../ui/Spinner.jsx";
import Button from "../ui/Button.jsx";
import PhotoThumb from "./PhotoThumb.jsx";
import { photoSelectionKey } from "../../hooks/useMultiSelect.js";
import { haptic } from "../../utils/haptics.js";

/** @param {number|null|undefined} ts */
export function dayKey(ts) {
  if (!ts) return "undated";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** @param {number|null|undefined} ts */
function dayLabel(ts) {
  if (!ts) return "Unknown date";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const COL_CLASS = {
  3: "grid-cols-3",
  4: "grid-cols-3 sm:grid-cols-4",
  5: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5",
  6: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6",
};

const FLOAT_IDLE_MS = 800;

/**
 * Date-grouped infinite photo grid.
 *
 * @param {{
 *   photos: object[],
 *   hasMore?: boolean,
 *   loadingMore?: boolean,
 *   onLoadMore?: () => void,
 *   onOpen?: (photo: object) => void,
 *   selectMode?: boolean,
 *   selectedKeys?: Set<string>,
 *   onToggle?: (photo: object, opts?: { range?: boolean }) => void,
 *   onLongPress?: (photo: object) => void,
 *   onFavoriteToggle?: (photo: object) => void,
 *   onDayClick?: (day: string, label: string) => void,
 *   onSelectDay?: (photos: object[]) => void,
 *   columns?: 3|4|5|6,
 * }} props
 */
export default function PhotoTimeline({
  photos,
  hasMore = false,
  loadingMore = false,
  onLoadMore = undefined,
  onOpen = undefined,
  selectMode = false,
  selectedKeys = undefined,
  onToggle = undefined,
  onLongPress = undefined,
  onFavoriteToggle = undefined,
  onDayClick = undefined,
  onSelectDay = undefined,
  columns = 6,
}) {
  const sentinel = useRef(null);
  const rootRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const dragSelecting = useRef(false);
  const [collapsed, setCollapsed] = useState(/** @type {Set<string>} */ (new Set()));
  const [floatLabel, setFloatLabel] = useState(/** @type {string|null} */ (null));
  const [floatVisible, setFloatVisible] = useState(false);
  const floatIdle = useRef(/** @type {ReturnType<typeof setTimeout>|null} */ (null));
  const lastFloat = useRef("");

  const groups = useMemo(() => {
    const map = new Map();
    let index = 0;
    for (const photo of photos) {
      const key = dayKey(photo.taken_at);
      if (!map.has(key)) map.set(key, { key, label: dayLabel(photo.taken_at), items: [] });
      map.get(key).items.push({ photo, index: index++ });
    }
    return [...map.values()];
  }, [photos]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore?.();
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore, photos.length]);

  // Floating date pill while scrolling (Immich-style).
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const sections = rootRef.current?.querySelectorAll("[data-day-section]");
    if (!sections?.length) return undefined;

    function reveal(label) {
      if (!label) return;
      if (label !== lastFloat.current) {
        lastFloat.current = label;
        setFloatLabel(label);
      }
      setFloatVisible(true);
      if (floatIdle.current) clearTimeout(floatIdle.current);
      floatIdle.current = setTimeout(() => setFloatVisible(false), FLOAT_IDLE_MS);
    }

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          const label = visible[0].target.getAttribute("data-day-label");
          if (label) reveal(label);
        }
      },
      { rootMargin: "-8% 0px -70% 0px", threshold: [0, 0.1, 0.5] },
    );
    sections.forEach((s) => io.observe(s));

    function onScroll() {
      // Keep pill alive while actively scrolling even if IO is quiet.
      if (lastFloat.current) reveal(lastFloat.current);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      if (floatIdle.current) clearTimeout(floatIdle.current);
    };
  }, [groups]);

  useEffect(() => {
    function endDrag() {
      dragSelecting.current = false;
    }
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, []);

  const toggleCollapsed = useCallback((key) => {
    haptic("light");
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const gridClass = COL_CLASS[columns] || COL_CLASS[6];

  return (
    <div className="relative space-y-8" data-slot="photo-timeline" ref={rootRef}>
      <div
        aria-live="polite"
        aria-hidden={!floatVisible}
        className={`pointer-events-none fixed left-1/2 top-20 z-30 -translate-x-1/2 rounded-pill bg-secondary text-primary border-2 border-primary/20 px-4 py-1.5 font-mono text-sm shadow-lg motion-safe:transition-opacity motion-safe:duration-200 motion-reduce:transition-none ${
          floatVisible && floatLabel ? "opacity-100" : "opacity-0"
        }`}
        data-slot="floating-day-pill"
      >
        {floatLabel || ""}
      </div>

      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.key);
        return (
          <section
            key={group.key}
            aria-labelledby={`day-${group.key}`}
            data-day-section={group.key}
            data-day-label={group.label}
          >
            <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 bg-primary/95 text-secondary px-1 py-2 backdrop-blur-sm">
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-pill hover:bg-secondary hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-safe:transition-colors"
                aria-expanded={!isCollapsed}
                aria-controls={`day-grid-${group.key}`}
                aria-label={isCollapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
                onClick={() => toggleCollapsed(group.key)}
              >
                {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
              </button>
              {onDayClick && group.key !== "undated" && !selectMode ? (
                <button
                  type="button"
                  id={`day-${group.key}`}
                  onClick={() => {
                    haptic("selection");
                    onDayClick(group.key, group.label);
                  }}
                  className="font-mono text-sm text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-pill"
                >
                  {group.label}
                </button>
              ) : (
                <h2 id={`day-${group.key}`} className="font-mono text-sm">
                  {group.label}
                </h2>
              )}
              {isCollapsed && (
                <span className="font-mono text-xs text-secondary">
                  {group.items.length} {group.items.length === 1 ? "photo" : "photos"}
                </span>
              )}
              {selectMode && onSelectDay && !isCollapsed && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  surface="primary"
                  onClick={() => {
                    haptic("selection");
                    onSelectDay(group.items.map((i) => i.photo));
                  }}
                >
                  Select day
                </Button>
              )}
            </div>
            {!isCollapsed && (
              <div id={`day-grid-${group.key}`} className={`grid gap-1 ${gridClass}`}>
                {group.items.map(({ photo, index }) => {
                  const key = photoSelectionKey(photo);
                  return (
                    <PhotoThumb
                      key={key || `${photo.drive_id}/${photo.path}`}
                      photo={photo}
                      index={index}
                      selected={!!selectedKeys?.has(key)}
                      selectMode={selectMode}
                      onOpen={selectMode ? undefined : onOpen}
                      onToggle={onToggle}
                      onLongPress={onLongPress}
                      onFavoriteToggle={onFavoriteToggle}
                      onDragSelectStart={
                        selectMode
                          ? () => {
                              dragSelecting.current = true;
                            }
                          : undefined
                      }
                      onDragSelectEnter={
                        selectMode
                          ? (p) => {
                              if (dragSelecting.current) onToggle?.(p, { range: true });
                            }
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
      <div ref={sentinel} className="h-8" aria-hidden="true" />
      {loadingMore && (
        <div
          className="flex items-center justify-center gap-2 py-4 text-secondary"
          role="status"
          aria-live="polite"
        >
          <p className="font-mono text-sm">Loading more…</p>
          <Spinner size="sm" decorative className="text-secondary shrink-0" />
        </div>
      )}
    </div>
  );
}

PhotoTimeline.propTypes = {
  photos: PropTypes.arrayOf(PropTypes.object).isRequired,
  hasMore: PropTypes.bool,
  loadingMore: PropTypes.bool,
  onLoadMore: PropTypes.func,
  onOpen: PropTypes.func,
  selectMode: PropTypes.bool,
  selectedKeys: PropTypes.instanceOf(Set),
  onToggle: PropTypes.func,
  onLongPress: PropTypes.func,
  onFavoriteToggle: PropTypes.func,
  onDayClick: PropTypes.func,
  onSelectDay: PropTypes.func,
  columns: PropTypes.oneOf([3, 4, 5, 6]),
};
