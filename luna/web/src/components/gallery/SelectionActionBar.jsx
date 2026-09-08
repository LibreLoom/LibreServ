import PropTypes from "prop-types";
import {
  Archive,
  Download,
  Heart,
  Images,
  Link2,
  Plus,
  Trash2,
} from "lucide-react";
import Button from "../ui/Button.jsx";

/**
 * Floating pill of bulk actions for selected photos (Files-style chrome).
 *
 * @param {{
 *   count: number,
 *   onFavorite?: () => void,
 *   onAddToAlbum?: () => void,
 *   onNewAlbum?: () => void,
 *   onShare?: () => void,
 *   onDownload?: () => void,
 *   onArchive?: () => void,
 *   onTrash?: () => void,
 *   onRemoveFromAlbum?: () => void,
 *   onClear?: () => void,
 *   favoriting?: boolean,
 *   archiving?: boolean,
 *   busy?: boolean,
 * }} props
 */
export default function SelectionActionBar({
  count,
  onFavorite,
  onAddToAlbum,
  onNewAlbum,
  onShare,
  onDownload,
  onArchive,
  onTrash,
  onRemoveFromAlbum,
  onClear,
  favoriting = false,
  archiving = false,
  busy = false,
}) {
  if (count <= 0) return null;

  return (
    <div
      data-slot="selection-action-bar"
      className="pointer-events-none fixed inset-x-0 bottom-24 z-[55] flex justify-center px-4"
    >
      <div
        role="toolbar"
        aria-label="Actions for selected photos"
        className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-pill bg-secondary text-primary border-2 border-primary/20 px-3 py-2 shadow-lg animate-nav-slide-in"
      >
        <span className="font-mono text-xs shrink-0 px-1">
          {count} selected
        </span>
        {onClear && (
          <Button variant="ghost" size="sm" onClick={onClear} disabled={busy}>
            Clear
          </Button>
        )}
        {onFavorite && (
          <Button
            variant="ghost"
            size="sm"
            loading={favoriting}
            disabled={busy}
            onClick={onFavorite}
            aria-label="Favorite selected"
          >
            <Heart size={16} />
            <span className="hidden sm:inline">Favorite</span>
          </Button>
        )}
        {onAddToAlbum && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onAddToAlbum} aria-label="Add to album">
            <Images size={16} />
            <span className="hidden sm:inline">Album</span>
          </Button>
        )}
        {onNewAlbum && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onNewAlbum} aria-label="New album from selection">
            <Plus size={16} />
            <span className="hidden sm:inline">New album</span>
          </Button>
        )}
        {onRemoveFromAlbum && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRemoveFromAlbum}>
            Remove
          </Button>
        )}
        {onShare && (
          <Button variant="ghost" size="sm" disabled={busy || count !== 1} onClick={onShare} aria-label="Share">
            <Link2 size={16} />
            <span className="hidden sm:inline">Share</span>
          </Button>
        )}
        {onDownload && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onDownload} aria-label="Download">
            <Download size={16} />
            <span className="hidden sm:inline">Download</span>
          </Button>
        )}
        {onArchive && (
          <Button
            variant="ghost"
            size="sm"
            loading={archiving}
            disabled={busy}
            onClick={onArchive}
            aria-label="Archive selected"
          >
            <Archive size={16} />
            <span className="hidden sm:inline">Archive</span>
          </Button>
        )}
        {onTrash && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onTrash} aria-label="Move to trash">
            <Trash2 size={16} />
            <span className="hidden sm:inline">Trash</span>
          </Button>
        )}
      </div>
    </div>
  );
}

SelectionActionBar.propTypes = {
  count: PropTypes.number.isRequired,
  onFavorite: PropTypes.func,
  onAddToAlbum: PropTypes.func,
  onNewAlbum: PropTypes.func,
  onShare: PropTypes.func,
  onDownload: PropTypes.func,
  onArchive: PropTypes.func,
  onTrash: PropTypes.func,
  onRemoveFromAlbum: PropTypes.func,
  onClear: PropTypes.func,
  favoriting: PropTypes.bool,
  archiving: PropTypes.bool,
  busy: PropTypes.bool,
};
