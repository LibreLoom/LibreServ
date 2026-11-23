import { memo, useLayoutEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Check, Play } from "lucide-react";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import PrivateBadge from "../private/PrivateBadge.jsx";
import { gridThumbSrcSet, isLunadThumb } from "./thumbSrc.js";
import { canWatchNearViewport, whenNearViewport } from "./nearViewport.js";

const LONG_PRESS_MS = 450;
/** Cells that fade in one after another when a grid first appears. */
const CASCADE_CELLS = 30;

/**
 * One photos photo as lunad lists it (`member_photo_json` in
 * `crates/lunad/src/api/photos.rs`), plus the client-side `content` and
 * `download` URLs a caller may attach. Every field is optional because the
 * grid, the lightbox and the public album link each receive a subset.
 *
 * @typedef {{
 *   drive_id?: string,
 *   path?: string,
 *   name?: string,
 *   kind?: string,
 *   size?: number,
 *   width?: number,
 *   height?: number,
 *   taken_at?: number|null,
 *   thumb?: string,
 *   content?: string,
 *   download?: string,
 *   favorited?: boolean,
 *   private?: boolean,
 *   lat?: number,
 *   lon?: number,
 *   place_label?: string,
 *   camera_make?: string,
 *   camera_model?: string,
 *   lens?: string,
 *   iso?: number,
 *   focal_mm?: number,
 *   flash?: number,
 *   duration_secs?: number,
 * }} PhotosPhoto
 */

/**
 * Dense edge-to-edge photo cell for the timeline grid.
 *
 * @param {{
 *   photo: PhotosPhoto,
 *   onOpen?: (photo: PhotosPhoto) => void,
 *   onToggle?: (photo: PhotosPhoto, opts?: { range?: boolean }) => void,
 *   onLongPress?: (photo: PhotosPhoto) => void,
 *   onDragSelectStart?: (photo: PhotosPhoto) => void,
 *   onDragSelectEnter?: (photo: PhotosPhoto) => void,
 *   selected?: boolean,
 *   selectMode?: boolean,
 *   index?: number,
 *   staggerIndex?: number,
 *   style?: object,
 *   sizes?: string,
 * }} props
 *   sizes: the cell's width for `srcset`; lunad thumbnails then come
 *   grid-sized where that is enough.
 */
function PhotoThumb({
  photo,
  onOpen = undefined,
  onToggle = undefined,
  onLongPress = undefined,
  onDragSelectStart = undefined,
  onDragSelectEnter = undefined,
  selected = false,
  selectMode = false,
  index = undefined,
  staggerIndex = undefined,
  style = undefined,
  sizes = undefined,
}) {
  const srcSet = sizes && isLunadThumb(photo.thumb) ? gridThumbSrcSet(photo.thumb) : undefined;
  // The image is asked for once the cell nears the screen (nearViewport.js),
  // so a jump loads what is in view first. Its src is set on the element,
  // not through a render; `data-thumb-pending` marks it until then (W7/W8).
  const [gated] = useState(canWatchNearViewport);
  const imgRef = useRef(/** @type {HTMLImageElement|null} */ (null));
  const started = useRef(false);
  const shownThumb = useRef(photo.thumb);
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (!gated || !img || !photo.thumb) return undefined;
    const show = () => {
      started.current = true;
      if (srcSet) img.srcset = srcSet;
      else img.removeAttribute("srcset");
      // A recycled cell may still carry the previous photo's loaded flag.
      delete img.dataset.thumbLoaded;
      img.src = photo.thumb || "";
      img.removeAttribute("data-thumb-pending");
    };
    if (started.current) {
      show();
      return undefined;
    }
    return whenNearViewport(img, show);
  }, [gated, photo.thumb, srcSet]);
  const longTimer = useRef(/** @type {ReturnType<typeof setTimeout>|null} */ (null));
  const longFired = useRef(false);
  const toggledOnPointerDown = useRef(false);
  const stagger = typeof index === "number" ? index : staggerIndex;
  const animationStyle =
    typeof stagger === "number"
      ? {
          // Only the first screen cascades. Clamping instead held every
          // later cell (a page loaded after a scroll) invisible for 1 s.
          animationDelay: `${stagger < CASCADE_CELLS ? stagger * 35 : 0}ms`,
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
    // A pointer click focuses this cell. Closing the viewer with Escape
    // then paints the keyboard focus ring on it. Only a keyboard open
    // should leave focus here.
    if (e.detail > 0) e.currentTarget.blur();
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
      className={`group relative block w-full aspect-square overflow-hidden surface-secondary animate-cascade-in motion-reduce:animate-none motion-reduce:transition-none motion-safe:transition-opacity hover:opacity-95 outline-none no-focus-outline focus-visible:ring-2 focus-visible:ring-accent ${
 selected ? "ring-2 ring-accent" : ""
 }`}
      aria-label={photo.private ? `${photo.name}, private` : photo.name}
    >
      {photo.thumb ? (
        <img
          ref={(img) => {
            imgRef.current = img;
            if (!img) return;
            // A recycled cell keeps the same <img>. Clear the previous
            // photo's loaded flag on both paths: the gated one sets src
            // imperatively, the ungated one gets it from React below.
            if (shownThumb.current !== photo.thumb) {
              delete img.dataset.thumbLoaded;
              shownThumb.current = photo.thumb;
            }
            if (img.complete && img.currentSrc) img.dataset.thumbLoaded = "1";
          }}
          src={gated ? undefined : photo.thumb}
          srcSet={gated ? undefined : srcSet}
          sizes={srcSet ? sizes : undefined}
          data-thumb-pending={gated ? "" : undefined}
          alt=""
          // Not "lazy" once gated: the browser would hold the src set above
          // for its own check at the next frame, behind any long render.
          loading={gated ? undefined : "lazy"}
          decoding="async"
          onLoad={(e) => {
            e.currentTarget.dataset.thumbLoaded = "1";
          }}
          className="h-full w-full object-cover opacity-0 motion-safe:transition-[opacity,scale] motion-safe:duration-300 motion-safe:ease-[var(--motion-easing-emphasized-decelerate)] group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:opacity-100"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-mono text-xs">
          {photo.kind === "video" ? "Video" : "Photo"}
        </span>
      )}
      {photo.kind === "video" && (
        <span className="absolute bottom-2 left-2 flex h-7 w-7 items-center justify-center rounded-pill surface-primary">
          <Play size={14} fill="currentColor" aria-hidden="true" />
        </span>
      )}
      {photo.private && (
        <span className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-pill surface-primary">
          <PrivateBadge size={12} />
        </span>
      )}
      {selected && (
        <span
          className="absolute top-2 left-2 flex h-6 w-6 items-center justify-center rounded-pill surface-secondary ring-2 ring-primary"
          aria-hidden="true"
        >
          <Check size={14} strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

export default memo(PhotoThumb);

PhotoThumb.propTypes = {
  photo: PropTypes.shape({
    name: PropTypes.string,
    thumb: PropTypes.string,
    kind: PropTypes.string,
    private: PropTypes.bool,
  }).isRequired,
  onOpen: PropTypes.func,
  onToggle: PropTypes.func,
  onLongPress: PropTypes.func,
  onDragSelectStart: PropTypes.func,
  onDragSelectEnter: PropTypes.func,
  selected: PropTypes.bool,
  selectMode: PropTypes.bool,
  index: PropTypes.number,
  staggerIndex: PropTypes.number,
  style: PropTypes.object,
  sizes: PropTypes.string,
};

PhotoThumb.defaultProps = {
  onOpen: undefined,
  onToggle: undefined,
  onLongPress: undefined,
  onDragSelectStart: undefined,
  onDragSelectEnter: undefined,
  selected: false,
  selectMode: false,
  index: undefined,
  staggerIndex: undefined,
  style: undefined,
  sizes: undefined,
};
