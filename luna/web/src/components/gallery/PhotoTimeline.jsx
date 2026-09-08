import { useEffect, useMemo, useRef } from "react";
import PropTypes from "prop-types";
import Spinner from "../ui/Spinner.jsx";
import PhotoThumb from "./PhotoThumb.jsx";
import { photoSelectionKey } from "../../hooks/useMultiSelect.js";

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
  columns = 6,
}) {
  const sentinel = useRef(null);
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

  const gridClass = COL_CLASS[columns] || COL_CLASS[6];

  return (
    <div className="space-y-8" data-slot="photo-timeline">
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`day-${group.key}`}>
          {onDayClick && group.key !== "undated" ? (
            <button
              type="button"
              id={`day-${group.key}`}
              onClick={() => onDayClick(group.key, group.label)}
              className="sticky top-0 z-10 mb-3 w-full bg-primary/95 text-secondary px-1 py-2 font-mono text-sm text-left backdrop-blur-sm hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-pill"
            >
              {group.label}
            </button>
          ) : (
            <h2
              id={`day-${group.key}`}
              className="sticky top-0 z-10 mb-3 bg-primary/95 text-secondary px-1 py-2 font-mono text-sm backdrop-blur-sm"
            >
              {group.label}
            </h2>
          )}
          <div className={`grid gap-1 ${gridClass}`}>
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
                />
              );
            })}
          </div>
        </section>
      ))}
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
  columns: PropTypes.oneOf([3, 4, 5, 6]),
};
