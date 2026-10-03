/* eslint-disable react-refresh/only-export-components -- timeline exports grouping helpers used by GalleryPage and tests */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Check, ChevronDown } from "lucide-react";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import PhotoThumb from "./PhotoThumb.jsx";
import { photoSelectionKey } from "../../hooks/useMultiSelect.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/** @param {number|null|undefined} ts */
export function dayKey(ts) {
  if (!ts) return "undated";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// One formatter for every day header — toLocaleDateString builds a new one per
// call, which adds up over thousands of days.
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

/** @param {number|null|undefined} ts */
function dayLabel(ts) {
  if (!ts) return "Unknown date";
  return DAY_FORMAT.format(new Date(ts * 1000));
}

const COL_CLASS = {
  3: "grid-cols-3",
  4: "grid-cols-3 sm:grid-cols-4",
  5: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5",
  6: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6",
};

/**
 * One day: sticky header plus its photo grid. Memoized with a custom check so
 * selecting a photo or loading the next page only re-renders the days it
 * touches, not every day on the page.
 */
const DaySection = memo(/** @param {any} props */ function DaySection({
  group,
  isCollapsed,
  selectedKeys,
  selectMode,
  gridClass,
  hasOpen,
  hasToggle,
  hasLongPress,
  hasDayClick,
  hasSelectDay,
  onToggleCollapsed,
  onDayClick,
  onSelectDay,
  onDeselectDay,
  onOpen,
  onToggle,
  onLongPress,
  onDragStart,
  onDragEnter,
}) {
  const dayPhotos = group.items.map((i) => i.photo);
  const allSelected =
    dayPhotos.length > 0 &&
    dayPhotos.every((p) => selectedKeys?.has(photoSelectionKey(p)));
  const showDaySelect = Boolean(selectMode && hasSelectDay);
  return (
    <section
      aria-labelledby={`day-${group.key}`}
    >
      <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 surface-primary px-1 py-2">
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-pill hover:bg-secondary hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-safe:transition-colors"
          aria-expanded={!isCollapsed}
          aria-controls={`day-grid-${group.key}`}
          aria-label={isCollapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
          onClick={() => onToggleCollapsed(group.key)}
        >
          <ChevronDown
            size={16}
            className={`motion-safe:transition-transform duration-200 ${isCollapsed ? "-rotate-90" : ""}`}
            aria-hidden="true"
          />
        </button>
        {hasDayClick && group.key !== "undated" && !selectMode ? (
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
        <div
          className={`grid shrink-0 min-w-0 motion-safe:transition-[grid-template-columns,opacity] motion-safe:duration-300 motion-safe:ease-[var(--motion-easing-emphasized)] ${
            showDaySelect
              ? "grid-cols-[1fr] opacity-100"
              : "grid-cols-[0fr] opacity-0 pointer-events-none"
          }`}
          aria-hidden={!showDaySelect}
        >
          {/* overflow-x-clip only so the focus ring isn't clipped;
              px-1 gives the ring room on the sides. */}
          <div className="min-w-0 overflow-x-clip px-1">
            <Button
              type="button"
              size="sm"
              variant={allSelected ? "secondary" : "outline"}
              // outline has border-2, secondary doesn't — without this
              // the button changes height when toggling state.
              className={allSelected ? "border-2 border-transparent" : ""}
              surface="primary"
              tabIndex={showDaySelect ? 0 : -1}
              aria-pressed={allSelected}
              onClick={() => {
                haptic("selection");
                if (allSelected) onDeselectDay?.(dayPhotos);
                else onSelectDay?.(dayPhotos);
              }}
            >
              {allSelected && <Check size={14} aria-hidden="true" />}
              {allSelected ? "Day selected" : "Select day"}
            </Button>
          </div>
        </div>
      </div>
      <div
        id={`day-grid-${group.key}`}
        aria-hidden={isCollapsed}
        inert={isCollapsed}
        className={`grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-300 motion-safe:ease-[var(--motion-easing-emphasized)] ${
          isCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
        }`}
      >
        <div className="photo-day-grid min-h-0 overflow-hidden p-1 -m-1">
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
                  onOpen={selectMode || !hasOpen ? undefined : onOpen}
                  onToggle={hasToggle ? onToggle : undefined}
                  onLongPress={hasLongPress ? onLongPress : undefined}
                  onDragSelectStart={selectMode ? onDragStart : undefined}
                  onDragSelectEnter={selectMode ? onDragEnter : undefined}
                />
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}, daySectionEqual);

/**
 * Same day, same photos, same selection within it, same view settings.
 * @param {any} prev
 * @param {any} next
 */
function daySectionEqual(prev, next) {
  for (const k of Object.keys(next)) {
    if (k === "group" || k === "selectedKeys") continue;
    if (prev[k] !== next[k]) return false;
  }
  const a = prev.group;
  const b = next.group;
  if (a !== b) {
    if (a.key !== b.key || a.label !== b.label || a.items.length !== b.items.length) return false;
    for (let i = 0; i < a.items.length; i++) {
      if (a.items[i].photo !== b.items[i].photo || a.items[i].index !== b.items[i].index) return false;
    }
  }
  if (prev.selectedKeys !== next.selectedKeys) {
    for (const { photo } of b.items) {
      const key = photoSelectionKey(photo);
      if (Boolean(prev.selectedKeys?.has(key)) !== Boolean(next.selectedKeys?.has(key))) return false;
    }
  }
  return true;
}

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
 *   onDayClick?: (day: string, label: string) => void,
 *   onSelectDay?: (photos: object[]) => void,
 *   onDeselectDay?: (photos: object[]) => void,
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
  onDayClick = undefined,
  onSelectDay = undefined,
  onDeselectDay = undefined,
  columns = 6,
}) {
  const sentinel = useRef(null);
  const dragSelecting = useRef(false);
  const [collapsed, setCollapsed] = useState(/** @type {Set<string>} */ (new Set()));

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
      { rootMargin: "1400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore, photos.length]);

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

  // Stable handlers for the memoized thumbs: they read the latest props
  // through a ref, so selecting one photo re-renders one thumb, not the grid.
  const latest = useRef({ onOpen, onToggle, onLongPress, onDayClick, onSelectDay, onDeselectDay });
  latest.current = { onOpen, onToggle, onLongPress, onDayClick, onSelectDay, onDeselectDay };
  const dayClick = useCallback((key, label) => latest.current.onDayClick?.(key, label), []);
  const selectDay = useCallback((photos) => latest.current.onSelectDay?.(photos), []);
  const deselectDay = useCallback((photos) => latest.current.onDeselectDay?.(photos), []);
  const open = useCallback((p) => latest.current.onOpen?.(p), []);
  const toggle = useCallback((p, opts) => latest.current.onToggle?.(p, opts), []);
  const longPress = useCallback((p) => latest.current.onLongPress?.(p), []);
  const dragStart = useCallback(() => {
    dragSelecting.current = true;
  }, []);
  const dragEnter = useCallback((p) => {
    if (dragSelecting.current) latest.current.onToggle?.(p, { range: true });
  }, []);

  const gridClass = COL_CLASS[columns] || COL_CLASS[6];

  return (
    <div className="relative space-y-8" data-slot="photo-timeline">
      {groups.map((group) => (
        <DaySection
          key={group.key}
          group={group}
          isCollapsed={collapsed.has(group.key)}
          selectedKeys={selectedKeys}
          selectMode={selectMode}
          gridClass={gridClass}
          hasOpen={Boolean(onOpen)}
          hasToggle={Boolean(onToggle)}
          hasLongPress={Boolean(onLongPress)}
          hasDayClick={Boolean(onDayClick)}
          hasSelectDay={Boolean(onSelectDay)}
          onToggleCollapsed={toggleCollapsed}
          onDayClick={dayClick}
          onSelectDay={selectDay}
          onDeselectDay={deselectDay}
          onOpen={open}
          onToggle={toggle}
          onLongPress={longPress}
          onDragStart={dragStart}
          onDragEnter={dragEnter}
        />
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
  onDayClick: PropTypes.func,
  onSelectDay: PropTypes.func,
  onDeselectDay: PropTypes.func,
  columns: PropTypes.oneOf([3, 4, 5, 6]),
};
