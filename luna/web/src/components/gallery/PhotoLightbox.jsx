import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Heart,
  Images,
  Link2,
  Trash2,
  X,
} from "lucide-react";
import Button from "../ui/Button.jsx";
import { contentHref, downloadHref, folderHref } from "../../lib/paths.js";
import { Link } from "react-router-dom";

/** Full-screen gallery lightbox layer. Modals opened from it must stack higher. */
export const LIGHTBOX_Z_CLASS = "z-[80]";
/** Use on ModalCard `overlayClassName` when the dialog opens over PhotoLightbox. */
export const ABOVE_LIGHTBOX_OVERLAY_CLASS = "z-[90]";

/**
 * Immersive full-screen photo/video viewer with manage actions.
 * @param {{
 *   photos: object[],
 *   index: number,
 *   onClose: () => void,
 *   onIndexChange: (index: number) => void,
 *   onFavorite?: (photo: object) => void,
 *   onShare?: (photo: object) => void,
 *   onAlbum?: (photo: object) => void,
 *   onTrash?: (photo: object) => void,
 *   favoriting?: boolean,
 * }} props
 */
export default function PhotoLightbox({
  photos,
  index,
  onClose,
  onIndexChange,
  onFavorite,
  onShare,
  onAlbum,
  onTrash,
  favoriting,
}) {
  const photo = photos[index];
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (!photo) return undefined;
    function onKey(e) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      if (e.key === "ArrowRight" && index < photos.length - 1) onIndexChange(index + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photo, index, photos.length, onClose, onIndexChange]);

  if (!photo) return null;

  const src = contentHref(photo.drive_id, photo.path);
  const folder = (photo.path || "").split("/").slice(0, -1).join("/");

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={photo.name}
      className={`fixed inset-0 ${LIGHTBOX_Z_CLASS} flex flex-col bg-primary text-secondary motion-safe:transition-opacity motion-safe:duration-200 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="font-mono text-sm truncate">{photo.name}</p>
          {photo.place_label && (
            <p className="text-xs truncate">{photo.place_label}</p>
          )}
        </div>
        <Button
          variant="ghost"
          surface="primary"
          size="icon"
          className="rounded-full shrink-0"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={20} />
        </Button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
        {index > 0 && (
          <Button
            variant="ghost"
            surface="primary"
            size="icon"
            className="absolute left-2 z-10 rounded-full shrink-0"
            aria-label="Previous"
            onClick={() => onIndexChange(index - 1)}
          >
            <ChevronLeft size={28} />
          </Button>
        )}
        {photo.kind === "video" ? (
          <video
            key={src}
            controls
            autoPlay
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
          />
        )}
        {index < photos.length - 1 && (
          <Button
            variant="ghost"
            surface="primary"
            size="icon"
            className="absolute right-2 z-10 rounded-full shrink-0"
            aria-label="Next"
            onClick={() => onIndexChange(index + 1)}
          >
            <ChevronRight size={28} />
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-4">
        <div className="flex flex-wrap items-center gap-2 rounded-pill bg-secondary text-primary px-2 py-2">
          <Button
            variant="ghost"
            size="sm"
            loading={favoriting}
            onClick={() => onFavorite?.(photo)}
            aria-label={photo.favorited ? "Remove favorite" : "Favorite"}
          >
            <Heart size={18} fill={photo.favorited ? "currentColor" : "none"} />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onAlbum?.(photo)} aria-label="Add to album">
            <Images size={18} />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onShare?.(photo)} aria-label="Share link">
            <Link2 size={18} />
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a href={downloadHref(photo.drive_id, photo.path)} download>
              <Download size={18} />
              <span className="sr-only">Download</span>
            </a>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to={folderHref(photo.drive_id, folder)}>
              <FolderOpen size={18} />
              <span className="sr-only">Open folder</span>
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onTrash?.(photo)}
            aria-label="Move to trash"
          >
            <Trash2 size={18} />
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

PhotoLightbox.propTypes = {
  photos: PropTypes.arrayOf(PropTypes.object).isRequired,
  index: PropTypes.number.isRequired,
  onClose: PropTypes.func.isRequired,
  onIndexChange: PropTypes.func.isRequired,
  onFavorite: PropTypes.func,
  onShare: PropTypes.func,
  onAlbum: PropTypes.func,
  onTrash: PropTypes.func,
  favoriting: PropTypes.bool,
};

PhotoLightbox.defaultProps = {
  favoriting: false,
};
