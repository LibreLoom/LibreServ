import { useEffect, useMemo, useRef } from "react";
import PropTypes from "prop-types";
import Spinner from "../ui/Spinner.jsx";
import PhotoThumb from "./PhotoThumb.jsx";

function dayKey(ts) {
  if (!ts) return "undated";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts) {
  if (!ts) return "Unknown date";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Date-grouped infinite photo grid. */
export default function PhotoTimeline({
  photos,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpen,
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

  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`day-${group.key}`}>
          <h2
            id={`day-${group.key}`}
            className="sticky top-0 z-10 mb-3 bg-primary/95 text-secondary px-1 py-2 font-mono text-sm backdrop-blur-sm"
          >
            {group.label}
          </h2>
          <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {group.items.map(({ photo, index }) => (
              <PhotoThumb
                key={`${photo.drive_id}/${photo.path}`}
                photo={photo}
                index={index}
                onClick={onOpen}
              />
            ))}
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
};
