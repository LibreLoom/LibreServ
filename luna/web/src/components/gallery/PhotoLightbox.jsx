/* eslint-disable react-refresh/only-export-components -- lightbox exports URL helpers used by gallery pages and tests */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import {
  ChevronLeft,
  ChevronRight,
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
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { ActionTooltipGroup, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import LightboxMedia from "./LightboxMedia.jsx";
import PhotoInfoPanel from "./PhotoInfoPanel.jsx";
import { contentHref, downloadHref, folderHref } from "../../lib/paths.js";
import { Link } from "react-router-dom";
import { lockBodyScroll } from "../../utils/bodyScrollLock.js";
import { photoSelectionKey } from "../../hooks/useMultiSelect.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { cn } from "@libreloom/ui/lib/utils.js";

/** Match `fullscreen-overlay-out` / `file-viewer-out` duration in index.css. */
const FULLSCREEN_EXIT_MS = 250;

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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
 *   open?: boolean,
 *   onClose: () => void,
 *   onIndexChange: (index: number) => void,
 *   onFavorite?: (photo: object) => void,
 *   onShare?: (photo: object) => void,
 *   onAlbum?: (photo: object) => void,
 *   onTrash?: (photo: object) => void,
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
  open = true,
  onClose,
  onIndexChange,
  onFavorite,
  onShare,
  onAlbum,
  onTrash,
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
  const [isClosing, setIsClosing] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const touchStartX = useRef(/** @type {number|null} */ (null));
  const guest = mode === "guest";
  const isClosingRef = useRef(false);
  const exitTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = useCallback(() => {
    if (isClosingRef.current) return;
    haptic("light");
    isClosingRef.current = true;
    setIsClosing(true);
    const delay = prefersReducedMotion() ? 0 : FULLSCREEN_EXIT_MS;
    if (delay === 0) {
      onCloseRef.current?.();
      return;
    }
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      onCloseRef.current?.();
    }, delay);
  }, []);

  useEffect(() => {
    if (!open && !isClosingRef.current) {
      requestClose();
    }
  }, [open, requestClose]);

  useEffect(() => () => {
    if (exitTimerRef.current != null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  useEffect(() => lockBodyScroll(), []);

  useEffect(() => {
    if (!photo) return undefined;
    function onKey(e) {
      if (isClosingRef.current) return;
      if (e.key === "Escape") {
        if (infoOpen) {
          haptic("light");
          setInfoOpen(false);
        } else {
          requestClose();
        }
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
  }, [photo, index, photos.length, requestClose, onIndexChange, onFavorite, onTrash, guest, infoOpen]);

  useEffect(() => {
    if (!slideshow || isClosing || photos.length < 2) return undefined;
    const id = setInterval(() => {
      onIndexChange(index >= photos.length - 1 ? 0 : index + 1);
    }, 4000);
    return () => clearInterval(id);
  }, [slideshow, isClosing, index, photos.length, onIndexChange]);

  if (!photo) return null;

  const src = resolveDisplaySrc(photo, { contentSrc });
  const dl = resolveDownloadSrc(photo, { downloadSrc });
  const folder = (photo.path || "").split("/").slice(0, -1).join("/");

  function onTouchStart(e) {
    if (isClosingRef.current) return;
    touchStartX.current = e.changedTouches?.[0]?.clientX ?? null;
  }
  function onTouchEnd(e) {
    if (isClosingRef.current) return;
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
      className={cn(
        `fixed inset-0 ${LIGHTBOX_Z_CLASS} flex flex-col overscroll-none bg-primary text-secondary`,
        isClosing
          ? "fullscreen-overlay-exit file-viewer-exit"
          : "fullscreen-overlay-enter file-viewer-enter",
      )}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="font-mono text-sm truncate">{photo.name}</p>
        </div>
        <ActionTooltipGroup className="flex items-center gap-1 shrink-0">
          {!guest && onSlideshowChange && (
            <Tooltip
              content={slideshow ? "Stop slideshow" : "Start slideshow"}
              popupClassName="z-[100]"
            >
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
            </Tooltip>
          )}
          <Tooltip content="Photo details" popupClassName="z-[100]">
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
          </Tooltip>
          <Tooltip content="Close" popupClassName="z-[100]">
            <Button
              variant="ghost"
              surface="primary"
              size="icon"
              className="rounded-full"
              onClick={requestClose}
              aria-label="Close"
            >
              <X size={20} />
            </Button>
          </Tooltip>
        </ActionTooltipGroup>
      </div>

      <div className="flex min-h-0 flex-1">
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
        {index > 0 && (
          <Tooltip content="Previous photo" popupClassName="z-[100]" className="absolute left-2 z-10">
            <Button
              variant="ghost"
              surface="primary"
              size="icon"
              className="rounded-full shrink-0"
              aria-label="Previous"
              onClick={() => {
                haptic("selection");
                onIndexChange(index - 1);
              }}
            >
              <ChevronLeft size={28} />
            </Button>
          </Tooltip>
        )}
        <LightboxMedia key={src} photo={photo} src={src} autoPlay={!slideshow} />
        {index < photos.length - 1 && (
          <Tooltip content="Next photo" popupClassName="z-[100]" className="absolute right-2 z-10">
            <Button
              variant="ghost"
              surface="primary"
              size="icon"
              className="rounded-full shrink-0"
              aria-label="Next"
              onClick={() => {
                haptic("selection");
                onIndexChange(index + 1);
              }}
            >
              <ChevronRight size={28} />
            </Button>
          </Tooltip>
        )}
      </div>

      <PhotoInfoPanel
        photo={photo}
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        photos={photos}
        onSelectPhoto={(p) => {
          const next = photos.indexOf(p);
          if (next >= 0 && next !== index) {
            haptic("selection");
            onIndexChange(next);
          }
        }}
      />
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-4">
        <ActionTooltipGroup className="flex flex-wrap items-center gap-2 rounded-pill bg-secondary text-primary px-2 py-2">
          {!guest && (
            <Tooltip
              content={photo.favorited ? "Remove from favorites" : "Favorite"}
              popupClassName="z-[100]"
            >
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
            </Tooltip>
          )}
          {!guest && (
            <Tooltip content="Add to album" popupClassName="z-[100]">
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
            </Tooltip>
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
            <Tooltip content="Copy a share link" popupClassName="z-[100]">
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
            </Tooltip>
          )}
          <Tooltip content="Download" popupClassName="z-[100]">
            <Button variant="ghost" size="sm" asChild>
              <a href={dl} download onClick={() => haptic("light")}>
                <Download size={18} />
                <span className="sr-only">Download</span>
              </a>
            </Button>
          </Tooltip>
          {!guest && photo.drive_id && (
            <Tooltip content="Open folder" popupClassName="z-[100]">
              <Button variant="ghost" size="sm" asChild>
                <Link to={folderHref(photo.drive_id, folder)} onClick={() => haptic("selection")}>
                  <FolderOpen size={18} />
                  <span className="sr-only">Open folder</span>
                </Link>
              </Button>
            </Tooltip>
          )}
          {!guest && (
            <Tooltip content="Move to trash" popupClassName="z-[100]">
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
            </Tooltip>
          )}
        </ActionTooltipGroup>
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
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  onIndexChange: PropTypes.func.isRequired,
  onFavorite: PropTypes.func,
  onShare: PropTypes.func,
  onAlbum: PropTypes.func,
  onTrash: PropTypes.func,
  onSetCover: PropTypes.func,
  slideshow: PropTypes.bool,
  onSlideshowChange: PropTypes.func,
  favoriting: PropTypes.bool,
};

PhotoLightbox.defaultProps = {
  favoriting: false,
  mode: "owner",
  open: true,
  slideshow: false,
};
