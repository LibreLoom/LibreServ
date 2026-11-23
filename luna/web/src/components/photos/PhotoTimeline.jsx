/* eslint-disable react-refresh/only-export-components -- timeline exports grouping helpers used by PhotosPage and tests */
import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Check, ChevronDown } from "lucide-react";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import PhotoThumb from "./PhotoThumb.jsx";
import { whenNearIdle } from "./nearViewport.js";
import { photoSelectionKey } from "../../hooks/useMultiSelect.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/** @typedef {import("./PhotoThumb.jsx").PhotosPhoto} PhotosPhoto */

/** @param {number|null|undefined} ts */
export function dayKey(ts) {
  if (ts == null) return "undated";
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
  if (ts == null) return "Unknown date";
  return DAY_FORMAT.format(new Date(ts * 1000));
}

const COL_CLASS = {
  3: "grid-cols-3",
  4: "grid-cols-3 sm:grid-cols-4",
  5: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5",
  6: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6",
};

// The column count each COL_CLASS shows at this screen width, as
// `--photo-cols` for the day grids' estimated height (index.css).
const COL_VARS = {
  3: "[--photo-cols:3]",
  4: "[--photo-cols:3] sm:[--photo-cols:4]",
  5: "[--photo-cols:3] sm:[--photo-cols:4] md:[--photo-cols:5]",
  6: "[--photo-cols:3] sm:[--photo-cols:4] md:[--photo-cols:5] lg:[--photo-cols:6]",
};

// A cell's width for each COL_CLASS, as `sizes` for the thumbnails' srcset:
// the whole viewport over the column count (a little over the real cell,
// so the browser errs toward the sharper thumbnail).
const COL_SIZES = {
  3: "34vw",
  4: "(min-width: 640px) 25vw, 34vw",
  5: "(min-width: 768px) 20vw, (min-width: 640px) 25vw, 34vw",
  6: "(min-width: 1024px) 17vw, (min-width: 768px) 20vw, (min-width: 640px) 25vw, 34vw",
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
  thumbSizes,
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
        <div
          data-thumb-group
          className="photo-day-grid min-h-0 overflow-hidden p-1 -m-1"
          style={/** @type {any} */ ({ "--day-photos": group.items.length })}
        >
          <div className={`grid gap-1 ${gridClass}`}>
            {group.items.map(({ photo, index }) => {
              const key = photoSelectionKey(photo);
              return (
                <PhotoThumb
                  key={key || `${photo.drive_id}/${photo.path}`}
                  photo={photo}
                  index={index}
                  sizes={thumbSizes}
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
 * @typedef {{ key: string, label: string, items: { photo: PhotosPhoto, index: number }[] }} DayGroup
 * @typedef {{ photos: PhotosPhoto[], groups: DayGroup[], at: Map<string, number> }} DayGrouping
 */

/**
 * Photos grouped by day, each day where its first photo is. Given the last
 * grouping (`prev`) and a list that only adds photos to its end, the days
 * before the new photos keep their objects, so the timeline re-renders only
 * the day the new page continues and the days it adds, and only the new
 * photos are grouped. Any other change groups the whole list again.
 * @param {PhotosPhoto[]} photos
 * @param {DayGrouping | null} [prev]
 * @returns {DayGrouping}
 */
export function groupByDay(photos, prev = null) {
  let from = 0;
  if (prev && prev.photos.length > 0 && prev.photos.length <= photos.length) {
    const old = prev.photos;
    let same = true;
    for (let i = 0; i < old.length; i++) {
      if (old[i] !== photos[i]) {
        same = false;
        break;
      }
    }
    if (same) {
      if (old.length === photos.length) return { ...prev, photos };
      from = old.length;
    }
  }
  const groups = from ? prev.groups.slice() : [];
  const at = from ? new Map(prev.at) : new Map();
  /** @type {Map<number, DayGroup["items"]>} days given new photos, by position */
  const grown = new Map();
  for (let index = from; index < photos.length; index++) {
    const photo = photos[index];
    const key = dayKey(photo.taken_at);
    let pos = at.get(key);
    if (pos === undefined) {
      pos = groups.length;
      at.set(key, pos);
      groups.push({ key, label: dayLabel(photo.taken_at), items: [] });
      grown.set(pos, groups[pos].items);
    }
    let items = grown.get(pos);
    if (!items) {
      items = groups[pos].items.slice();
      grown.set(pos, items);
    }
    items.push({ photo, index });
  }
  for (const [pos, items] of grown) {
    if (groups[pos].items !== items) groups[pos] = { ...groups[pos], items };
  }
  return { photos, groups, at };
}

// Photos drawn in the first frame a timeline mounts; the rest follow in a
// background render React can pause. A page sliding in (SlidePages) can then
// start moving at once instead of waiting for every thumbnail, and the rest
// lands below the fold a moment later. A page the timeline asked for while
// scrolling is drawn the same way, in whole days: its first photos, the ones
// that can be on screen at the bottom of the timeline, start their thumbnails
// without waiting for the whole page to render (W8 in luna/perf).
const FIRST_PAINT_PHOTOS = 36;
// The rest of such a page waits for the thumbnails on screen to load, so
// building it doesn't hold back their paint; at most this long (ms).
const REST_WAIT_MAX_MS = 400;
/** And then for the browser to be idle, at most this long (ms). */
const REST_IDLE_MAX_MS = 300;

/**
 * Date-grouped infinite photo grid.
 *
 * @param {{
 *   photos: PhotosPhoto[],
 *   hasMore?: boolean,
 *   loadingMore?: boolean,
 *   onLoadMore?: () => void,
 *   onOpen?: (photo: PhotosPhoto) => void,
 *   selectMode?: boolean,
 *   selectedKeys?: Set<string>,
 *   onToggle?: (photo: PhotosPhoto, opts?: { range?: boolean }) => void,
 *   onLongPress?: (photo: PhotosPhoto) => void,
 *   onDayClick?: (day: string, label: string) => void,
 *   onSelectDay?: (photos: PhotosPhoto[]) => void,
 *   onDeselectDay?: (photos: PhotosPhoto[]) => void,
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
  const root = useRef(/** @type {HTMLDivElement | null} */ (null));
  const dragSelecting = useRef(false);
  const [collapsed, setCollapsed] = useState(/** @type {Set<string>} */ (new Set()));

  // The last grouping, so a new page groups only its own photos. Always a
  // complete grouping of some list; groupByDay checks it still applies.
  const lastGrouping = useRef(/** @type {DayGrouping | null} */ (null));
  const grouping = useMemo(() => groupByDay(photos, lastGrouping.current), [photos]);
  lastGrouping.current = grouping;
  const groups = grouping.groups;

  // How many photos are drawn, in list order (Infinity: all of them).
  const [drawn, setDrawn] = useState(photos.length <= FIRST_PAINT_PHOTOS ? Infinity : FIRST_PAINT_PHOTOS);
  // The photo count when the timeline last asked for a page, until it lands.
  const [askedAt, setAskedAt] = useState(-1);
  // True while the rest of an asked-for page waits for the screen's thumbnails.
  const [restWaits, setRestWaits] = useState(false);
  if (askedAt >= 0 && photos.length !== askedAt) {
    setAskedAt(-1);
    // Whole days only: a day drawn in part would show a short photo count
    // and select only part of itself.
    let upTo = 0;
    for (const group of groups) {
      upTo += group.items.length;
      if (upTo >= askedAt + FIRST_PAINT_PHOTOS) break;
    }
    if (drawn >= askedAt && upTo < photos.length) {
      setDrawn(upTo);
      setRestWaits(true);
    }
  }
  const drawAll = drawn >= photos.length;
  useEffect(() => {
    if (drawAll) return undefined;
    const drawRest = () => {
      startTransition(() => {
        setDrawn(Infinity);
        setRestWaits(false);
      });
    };
    if (!restWaits || typeof requestAnimationFrame !== "function") {
      drawRest();
      return undefined;
    }
    let idle = 0;
    let frame = 0;
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      // Once the browser is idle, so the thumbnails that just loaded are
      // decoded and painted first.
      if (typeof requestIdleCallback === "function") {
        idle = requestIdleCallback(drawRest, { timeout: REST_IDLE_MAX_MS });
      } else {
        frame = requestAnimationFrame(() => {
          frame = 0;
          idle = window.setTimeout(drawRest, 0);
        });
      }
    };
    const cancel = whenNearIdle(go);
    const timer = setTimeout(go, REST_WAIT_MAX_MS);
    return () => {
      cancel();
      clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      if (idle && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      else if (idle) clearTimeout(idle);
    };
  }, [drawAll, restWaits]);
  const shownGroups = useMemo(() => {
    if (drawn >= photos.length) return groups;
    const out = [];
    let left = drawn;
    for (const group of groups) {
      if (left <= 0) break;
      out.push(group.items.length <= left ? group : { ...group, items: group.items.slice(0, left) });
      left -= group.items.length;
    }
    return out;
  }, [drawn, groups, photos.length]);

  useEffect(() => {
    const el = sentinel.current;
    // Not before every photo is drawn: the short first frame would show the
    // sentinel and fetch a page nobody scrolled to.
    if (!el || !hasMore || !drawAll) return undefined;
    // Two frames later: after a jump, the days now on screen draw in the
    // next frame and ask for their thumbnails then. Drawing the next page
    // first held those requests back behind its long render (W8).
    let frame = 0;
    const count = photos.length;
    const loadMore = () => {
      setAskedAt(count);
      onLoadMore?.();
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (typeof requestAnimationFrame !== "function") {
          loadMore();
          return;
        }
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(loadMore);
        });
      },
      { rootMargin: "1400px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [hasMore, onLoadMore, photos.length, drawAll]);

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

  // A day grid off screen skips layout and stands in at an estimated height
  // (index.css), worked out from its photo count, the column count and this
  // width. A good guess keeps a jump where it landed: a wrong one moved the
  // page as days came into view, and the thumbnails asked for at the first
  // spot were not the ones left on screen (W8 in luna/perf). Set on the
  // element, not through a render.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const set = () => el.style.setProperty("--timeline-w", `${el.clientWidth}px`);
    set();
    if (typeof ResizeObserver !== "function") return undefined;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={root} className={`relative space-y-8 ${COL_VARS[columns] || COL_VARS[6]}`} data-slot="photo-timeline">
      {shownGroups.map((group) => (
        <DaySection
          key={group.key}
          group={group}
          isCollapsed={collapsed.has(group.key)}
          selectedKeys={selectedKeys}
          selectMode={selectMode}
          gridClass={gridClass}
          thumbSizes={COL_SIZES[columns] || COL_SIZES[6]}
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
