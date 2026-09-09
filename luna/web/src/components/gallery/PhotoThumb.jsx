import { useRef, useState } from "react";
import PropTypes from "prop-types";
import { Check, Heart, Play } from "lucide-react";
import { haptic } from "../../utils/haptics.js";

const LONG_PRESS_MS = 450;

/**
 * Dense edge-to-edge photo cell for the timeline grid.
 *
 * @param {{
 *   photo: object,
 *   onOpen?: (photo: object) => void,
 *   onToggle?: (photo: object, opts?: { range?: boolean }) => void,
 *   onLongPress?: (photo: object) => void,
 *   onFavoriteToggle?: (photo: object, event: import("react").MouseEvent) => void,
 *   onDragSelectStart?: (photo: object) => void,
 *   onDragSelectEnter?: (photo: object) => void,
 *   selected?: boolean,
 *   selectMode?: boolean,
 *   index?: number,
 *   staggerIndex?: number,
 *   style?: object,
 * }} props
 */
export default function PhotoThumb({
  photo,
  onOpen = undefined,
  onToggle = undefined,
  onLongPress = undefined,
  onFavoriteToggle = undefined,
  onDragSelectStart = undefined,
  onDragSelectEnter = undefined,
  selected = false,
  selectMode = false,
  index = undefined,
  staggerIndex = undefined,
  style = undefined,
}) {
  const [loaded, setLoaded] = useState(false);
  const longTimer = useRef(/** @type {ReturnType<typeof setTimeout>|null} */ (null));
  const longFired = useRef(false);
  const toggledOnPointerDown = useRef(false);
  const stagger = typeof index === "number" ? index : staggerIndex;
  const animationStyle =
    typeof stagger === "number"
      ? {
          animationDelay: `${Math.min(stagger, 30) * 35}ms`,
          animationFillMode: "backwards",
          ...style,
        }
      : style;

  function clearLong() {
    if (longTimer.current) {
      clearTimeout(longTimer.current);
      longTimer.current = null;
    }
  }

  function startLong(e) {
    // Desktop drag-to-select: primary button down starts a range drag.
    if (selectMode && e.button === 0 && onDragSelectStart) {
      haptic("selection");
      onDragSelectStart(photo);
      onToggle?.(photo, { range: false });
      toggledOnPointerDown.current = true;
    }
    clearLong();
    longFired.current = false;
    longTimer.current = setTimeout(() => {
      longFired.current = true;
      haptic("rigid");
      onLongPress?.(photo);
    }, LONG_PRESS_MS);
  }

  function handleClick(e) {
    if (longFired.current) {
      longFired.current = false;
      return;
    }
    if (selectMode || e.shiftKey) {
      if (toggledOnPointerDown.current) {
        toggledOnPointerDown.current = false;
        return;
      }
      haptic("selection");
      onToggle?.(photo, { range: e.shiftKey });
      return;
    }
    haptic("medium");
    onOpen?.(photo);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={startLong}
      onPointerUp={clearLong}
      onPointerLeave={clearLong}
      onPointerCancel={clearLong}
      onPointerEnter={() => {
        if (selectMode && onDragSelectEnter) {
          haptic("selection");
          onDragSelectEnter(photo);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        haptic("rigid");
        onLongPress?.(photo);
      }}
      style={animationStyle}
      aria-pressed={selectMode ? selected : undefined}
      className={`group relative block w-full aspect-square overflow-hidden bg-secondary text-primary animate-cascade-in motion-reduce:animate-none motion-reduce:transition-none motion-safe:transition-opacity hover:opacity-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        selected ? "ring-2 ring-accent" : ""
      }`}
      aria-label={photo.name}
    >
      {photo.thumb ? (
        <img
          src={photo.thumb}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          ref={(img) => {
            if (img?.complete) setLoaded(true);
          }}
          className={`h-full w-full object-cover motion-safe:transition-[opacity,transform] motion-safe:duration-300 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:opacity-100 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-mono text-xs">
          {photo.kind === "video" ? "Video" : "Photo"}
        </span>
      )}
      {photo.kind === "video" && (
        <span className="absolute bottom-2 left-2 flex h-7 w-7 items-center justify-center rounded-pill bg-primary text-secondary">
          <Play size={14} fill="currentColor" aria-hidden="true" />
        </span>
      )}
      {selected && (
        <span
          className="absolute top-2 left-2 flex h-6 w-6 items-center justify-center rounded-pill bg-accent text-primary"
          aria-hidden="true"
        >
          <Check size={14} strokeWidth={3} />
        </span>
      )}
      {onFavoriteToggle && !selectMode ? (
        <span
          role="button"
          tabIndex={0}
          className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-pill bg-primary/90 text-secondary [filter:drop-shadow(0_0_1.5px_var(--secondary))]"
          aria-label={photo.favorited ? "Remove favorite" : "Favorite"}
          onClick={(e) => {
            e.stopPropagation();
            haptic("selection");
            onFavoriteToggle(photo, e);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              haptic("selection");
              onFavoriteToggle(photo, /** @type {any} */ (e));
            }
          }}
        >
          <Heart
            size={14}
            className={photo.favorited ? "fill-secondary stroke-secondary" : "stroke-secondary"}
            strokeWidth={2.25}
            aria-hidden="true"
          />
        </span>
      ) : (
        photo.favorited && (
          <span
            className="absolute top-2 right-2 [filter:drop-shadow(0_0_1.5px_var(--secondary))]"
            aria-hidden="true"
          >
            <Heart
              size={14}
              className="fill-primary stroke-secondary"
              strokeWidth={2.25}
              aria-hidden="true"
            />
          </span>
        )
      )}
    </button>
  );
}

PhotoThumb.propTypes = {
  photo: PropTypes.shape({
    name: PropTypes.string,
    thumb: PropTypes.string,
    kind: PropTypes.string,
    favorited: PropTypes.bool,
  }).isRequired,
  onOpen: PropTypes.func,
  onToggle: PropTypes.func,
  onLongPress: PropTypes.func,
  onFavoriteToggle: PropTypes.func,
  onDragSelectStart: PropTypes.func,
  onDragSelectEnter: PropTypes.func,
  selected: PropTypes.bool,
  selectMode: PropTypes.bool,
  index: PropTypes.number,
  staggerIndex: PropTypes.number,
  style: PropTypes.object,
};

PhotoThumb.defaultProps = {
  onOpen: undefined,
  onToggle: undefined,
  onLongPress: undefined,
  onFavoriteToggle: undefined,
  onDragSelectStart: undefined,
  onDragSelectEnter: undefined,
  selected: false,
  selectMode: false,
  index: undefined,
  staggerIndex: undefined,
  style: undefined,
};
