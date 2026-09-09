/* eslint-disable react-refresh/only-export-components -- lightbox exports URL helpers used by gallery pages and tests */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import {
  ChevronLeft,
  ChevronRight,
  Crop,
  Download,
  FolderOpen,
  Heart,
  Images,
  Info,
  Link2,
  Play,
  Trash2,
  X,
} from "lucide-react";
import Button from "../ui/Button.jsx";
import { contentHref, downloadHref, folderHref, fmtSize } from "../../lib/paths.js";
import { Link } from "react-router-dom";
import { lockBodyScroll } from "../../utils/bodyScrollLock.js";
import { photoSelectionKey } from "../../hooks/useMultiSelect.js";
import { haptic } from "../../utils/haptics.js";

/** Full-screen gallery lightbox layer. Modals opened from it must stack higher. */
export const LIGHTBOX_Z_CLASS = "z-[80]";
/** Use on ModalCard `overlayClassName` when the dialog opens over PhotoLightbox. */
export const ABOVE_LIGHTBOX_OVERLAY_CLASS = "z-[90]";

/**
 * @param {string} name
 */
function isHeicName(name) {
  return /\.(heic|heif)$/i.test(name || "");
}

/**
 * Prefer gallery preview for HEIC when available; otherwise drive content URL.
 * @param {object} photo
 * @param {{ contentSrc?: string }} [opts]
 */
export function resolveDisplaySrc(photo, opts = {}) {
  if (opts.contentSrc) return opts.contentSrc;
  if (photo?.content) return photo.content;
  if (isHeicName(photo?.name) && photo?.drive_id && photo?.path) {
    // TODO: backend `/api/v1/gallery/preview` may still be landing — fall back to content if 404.
    return `/api/v1/gallery/preview?drive_id=${encodeURIComponent(photo.drive_id)}&path=${encodeURIComponent(photo.path)}`;
  }
  if (photo?.drive_id && photo?.path) return contentHref(photo.drive_id, photo.path);
  return photo?.thumb || "";
}

/**
 * @param {object} photo
 * @param {{ downloadSrc?: string }} [opts]
 */
export function resolveDownloadSrc(photo, opts = {}) {
  if (opts.downloadSrc) return opts.downloadSrc;
  if (photo?.download) return photo.download;
  if (photo?.drive_id && photo?.path) return downloadHref(photo.drive_id, photo.path);
  return photo?.thumb || "";
}

/**
 * Immersive full-screen photo/video viewer.
 *
 * @param {{
 *   photos: object[],
 *   index?: number,
 *   photoKey?: string,
 *   mode?: "owner"|"guest",
 *   contentSrc?: string,
 *   downloadSrc?: string,
 *   onClose: () => void,
 *   onIndexChange: (index: number) => void,
 *   onFavorite?: (photo: object) => void,
 *   onShare?: (photo: object) => void,
 *   onAlbum?: (photo: object) => void,
 *   onTrash?: (photo: object) => void,
 *   onEdit?: (photo: object) => void,
 *   onSetCover?: (photo: object) => void,
 *   slideshow?: boolean,
 *   onSlideshowChange?: (on: boolean) => void,
 *   favoriting?: boolean,
 * }} props
 */
export default function PhotoLightbox({
  photos,
  index: indexProp,
  photoKey,
  mode = "owner",
  contentSrc,
  downloadSrc,
  onClose,
  onIndexChange,
  onFavorite,
  onShare,
  onAlbum,
  onTrash,
  onEdit,
  onSetCover,
  slideshow = false,
  onSlideshowChange,
  favoriting,
}) {
  const resolvedIndex = useMemo(() => {
    if (photoKey) {
      const found = photos.findIndex((p) => photoSelectionKey(p) === photoKey);
      if (found >= 0) return found;
    }
    return typeof indexProp === "number" ? indexProp : 0;
  }, [photoKey, photos, indexProp]);

  const index = Math.max(0, Math.min(resolvedIndex, Math.max(photos.length - 1, 0)));
  const photo = photos[index];
  const [visible, setVisible] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const touchStartX = useRef(/** @type {number|null} */ (null));
  const guest = mode === "guest";

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => lockBodyScroll(), []);

  useEffect(() => {
    if (!photo) return undefined;
    function onKey(e) {
      if (e.key === "Escape") {
        haptic("light");
        onClose();
      }
      if (e.key === "ArrowLeft") {
        if (index > 0) {
          haptic("selection");
          onIndexChange(index - 1);
        } else {
          haptic("rigid");
        }
      }
      if (e.key === "ArrowRight") {
        if (index < photos.length - 1) {
          haptic("selection");
          onIndexChange(index + 1);
        } else {
          haptic("rigid");
        }
      }
      if (!guest && (e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        haptic("selection");
        onFavorite?.(photo);
      }
      if (!guest && e.key === "Delete") {
        e.preventDefault();
        onTrash?.(photo);
      }
      if ((e.key === "i" || e.key === "I") && !e.metaKey && !e.ctrlKey) {
        haptic("light");
        setInfoOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photo, index, photos.length, onClose, onIndexChange, onFavorite, onTrash, guest]);

  useEffect(() => {
    if (!slideshow || photos.length < 2) return undefined;
    const id = setInterval(() => {
      onIndexChange(index >= photos.length - 1 ? 0 : index + 1);
    }, 4000);
    return () => clearInterval(id);
  }, [slideshow, index, photos.length, onIndexChange]);

  if (!photo) return null;

  const src = resolveDisplaySrc(photo, { contentSrc });
  const dl = resolveDownloadSrc(photo, { downloadSrc });
  const folder = (photo.path || "").split("/").slice(0, -1).join("/");

  function onTouchStart(e) {
    touchStartX.current = e.changedTouches?.[0]?.clientX ?? null;
  }
  function onTouchEnd(e) {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (start == null) return;
    const end = e.changedTouches?.[0]?.clientX;
    if (end == null) return;
    const dx = end - start;
    if (Math.abs(dx) < 60) return;
    if (dx < 0) {
      if (index < photos.length - 1) {
        haptic("selection");
        onIndexChange(index + 1);
      } else {
        haptic("rigid");
      }
    }
    if (dx > 0) {
      if (index > 0) {
        haptic("selection");
        onIndexChange(index - 1);
      } else {
        haptic("rigid");
      }
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={photo.name}
      data-slot="photo-lightbox"
      data-mode={mode}
      className={`fixed inset-0 ${LIGHTBOX_Z_CLASS} flex flex-col overscroll-none bg-primary text-secondary motion-safe:transition-opacity motion-safe:duration-200 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="font-mono text-sm truncate">{photo.name}</p>
          {photo.place_label && (
            <p className="text-xs truncate">{photo.place_label}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!guest && onSlideshowChange && (
            <Button
              variant="ghost"
              surface="primary"
              size="icon"
              className="rounded-full"
              aria-label={slideshow ? "Stop slideshow" : "Start slideshow"}
              aria-pressed={slideshow}
              onClick={() => {
                haptic("light");
                onSlideshowChange(!slideshow);
              }}
            >
              <Play size={18} fill={slideshow ? "currentColor" : "none"} />
            </Button>
          )}
          <Button
            variant="ghost"
            surface="primary"
            size="icon"
            className="rounded-full"
            aria-label="Photo details"
            aria-pressed={infoOpen}
            onClick={() => {
              haptic("light");
              setInfoOpen((v) => !v);
            }}
          >
            <Info size={18} />
          </Button>
          <Button
            variant="ghost"
            surface="primary"
            size="icon"
            className="rounded-full"
            onClick={() => {
              haptic("light");
              onClose();
            }}
            aria-label="Close"
          >
            <X size={20} />
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
        {index > 0 && (
          <Button
            variant="ghost"
            surface="primary"
            size="icon"
            className="absolute left-2 z-10 rounded-full shrink-0"
            aria-label="Previous"
            onClick={() => {
              haptic("selection");
              onIndexChange(index - 1);
            }}
          >
            <ChevronLeft size={28} />
          </Button>
        )}
        {photo.kind === "video" ? (
          <video
            key={src}
            controls
            autoPlay={!slideshow}
            className="max-h-full max-w-full rounded-large-element"
            src={src}
          >
            Your browser cannot play this video. Download it instead.
          </video>
        ) : (
          <img
            key={src}
            src={src}
            alt={photo.name}
            className="max-h-full max-w-full object-contain motion-safe:animate-page-enter"
            onError={(e) => {
              // HEIC preview may 404 until backend lands — fall back to thumb.
              if (photo.thumb && e.currentTarget.src !== photo.thumb) {
                e.currentTarget.src = photo.thumb;
              }
            }}
          />
        )}
        {index < photos.length - 1 && (
          <Button
            variant="ghost"
            surface="primary"
            size="icon"
            className="absolute right-2 z-10 rounded-full shrink-0"
            aria-label="Next"
            onClick={() => {
              haptic("selection");
              onIndexChange(index + 1);
            }}
          >
            <ChevronRight size={28} />
          </Button>
        )}
      </div>

      {infoOpen && (
        <div
          data-slot="photo-info-drawer"
          className="mx-4 mb-2 rounded-large-element bg-secondary text-primary p-4 space-y-1 text-sm animate-nav-slide-in"
        >
          <p className="font-mono">{photo.name}</p>
          {photo.taken_at ? (
            <p>{new Date(photo.taken_at * 1000).toLocaleString()}</p>
          ) : (
            <p>Date unknown</p>
          )}
          {photo.place_label && <p>{photo.place_label}</p>}
          {photo.size != null && <p>{fmtSize(photo.size)}</p>}
          {(photo.width > 0 || photo.height > 0) && (
            <p>
              {photo.width} × {photo.height}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-4">
        <div className="flex flex-wrap items-center gap-2 rounded-pill bg-secondary text-primary px-2 py-2">
          {!guest && (
            <Button
              variant="ghost"
              size="sm"
              loading={favoriting}
              onClick={() => {
                haptic("selection");
                onFavorite?.(photo);
              }}
              aria-label={photo.favorited ? "Remove favorite" : "Favorite"}
            >
              <Heart size={18} fill={photo.favorited ? "currentColor" : "none"} />
            </Button>
          )}
          {!guest && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                haptic("light");
                onAlbum?.(photo);
              }}
              aria-label="Add to album"
            >
              <Images size={18} />
            </Button>
          )}
          {!guest && onSetCover && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                haptic("selection");
                onSetCover(photo);
              }}
              aria-label="Set as album cover"
            >
              Set as cover
            </Button>
          )}
          {!guest && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                haptic("light");
                onShare?.(photo);
              }}
              aria-label="Share link"
            >
              <Link2 size={18} />
            </Button>
          )}
          {!guest && onEdit && photo.kind !== "video" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                haptic("light");
                onEdit(photo);
              }}
              aria-label="Crop or rotate"
            >
              <Crop size={18} />
            </Button>
          )}
          <Button variant="ghost" size="sm" asChild>
            <a href={dl} download onClick={() => haptic("light")}>
              <Download size={18} />
              <span className="sr-only">Download</span>
            </a>
          </Button>
          {!guest && photo.drive_id && (
            <Button variant="ghost" size="sm" asChild>
              <Link to={folderHref(photo.drive_id, folder)} onClick={() => haptic("selection")}>
                <FolderOpen size={18} />
                <span className="sr-only">Open folder</span>
              </Link>
            </Button>
          )}
          {!guest && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                haptic("warning");
                onTrash?.(photo);
              }}
              aria-label="Move to trash"
            >
              <Trash2 size={18} />
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

PhotoLightbox.propTypes = {
  photos: PropTypes.arrayOf(PropTypes.object).isRequired,
  index: PropTypes.number,
  photoKey: PropTypes.string,
  mode: PropTypes.oneOf(["owner", "guest"]),
  contentSrc: PropTypes.string,
  downloadSrc: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  onIndexChange: PropTypes.func.isRequired,
  onFavorite: PropTypes.func,
  onShare: PropTypes.func,
  onAlbum: PropTypes.func,
  onTrash: PropTypes.func,
  onEdit: PropTypes.func,
  onSetCover: PropTypes.func,
  slideshow: PropTypes.bool,
  onSlideshowChange: PropTypes.func,
  favoriting: PropTypes.bool,
};

PhotoLightbox.defaultProps = {
  favoriting: false,
  mode: "owner",
  slideshow: false,
};
