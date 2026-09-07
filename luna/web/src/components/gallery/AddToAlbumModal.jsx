import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Check, Search } from "lucide-react";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import ModalErrorNotice from "../common/ModalErrorNotice.jsx";
import Spinner from "../ui/Spinner.jsx";
import { cn } from "@/lib/utils";

/**
 * @param {{ home_drive_id: string, id: string }} album
 */
export function albumKey(album) {
  return `${album.home_drive_id}:${album.id}`;
}

/**
 * Pick one album and add a photo to it.
 * Backend accepts one album per request (`POST …/albums/{home}/{id}/items`),
 * so this UI is single-select.
 *
 * @param {{
 *   open: boolean,
 *   albums?: Array<{ id: string, home_drive_id: string, name: string, item_count?: number, shared?: boolean }>,
 *   albumsLoading?: boolean,
 *   adding?: boolean,
 *   error?: string | null,
 *   onAdd: (album: { id: string, home_drive_id: string, name: string }, close: () => void) => void,
 *   onClose: () => void,
 *   overlayClassName?: string,
 * }} props
 */
export default function AddToAlbumModal({
  open,
  albums = [],
  albumsLoading = false,
  adding = false,
  error = null,
  onAdd,
  onClose,
  overlayClassName,
}) {
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState(/** @type {string|null} */ (null));
  const searchRef = useRef(/** @type {HTMLInputElement|null} */ (null));

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset draft UI when the modal opens
    setQuery("");
    setSelectedKey(null);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return albums;
    return albums.filter((album) => album.name.toLowerCase().includes(needle));
  }, [albums, query]);

  const selectedAlbum = useMemo(
    () => albums.find((album) => albumKey(album) === selectedKey) || null,
    [albums, selectedKey],
  );

  return (
    <ModalCard
      open={open}
      title="Add to album"
      onClose={onClose}
      overlayClassName={overlayClassName}
      initialFocusRef={searchRef}
    >
      {({ close }) => (
        <div className="space-y-4">
          <ModalErrorNotice error={error} />

          {albumsLoading ? (
            <div
              className="flex items-center justify-center gap-3 py-10 text-primary"
              role="status"
              aria-live="polite"
            >
              <p className="text-sm font-mono">Loading albums…</p>
              <Spinner size="lg" decorative className="text-primary" />
            </div>
          ) : albums.length === 0 ? (
            <p className="text-sm text-primary">
              Create an album first, then add photos to it.
            </p>
          ) : (
            <>
              <label className="block text-sm text-primary">
                Find an album
                <div className="relative mt-1">
                  <Search
                    size={16}
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-accent pointer-events-none"
                    aria-hidden="true"
                  />
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search albums…"
                    aria-label="Search albums"
                    disabled={adding}
                    className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 pl-11 pr-4 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
                  />
                </div>
              </label>

              <div
                role="listbox"
                aria-label="Albums"
                className="max-h-56 overflow-y-auto overscroll-contain space-y-2 rounded-large-element bg-primary text-secondary p-2 border-2 border-secondary/20"
              >
                {filtered.length === 0 ? (
                  <p className="px-3 py-4 text-sm text-secondary">
                    No albums match “{query.trim()}”. Try another name.
                  </p>
                ) : (
                  filtered.map((album) => {
                    const key = albumKey(album);
                    const selected = selectedKey === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        disabled={adding}
                        onClick={() => setSelectedKey(key)}
                        className={cn(
                          "w-full flex items-center gap-3 rounded-pill px-4 py-2.5 text-left motion-safe:transition-colors",
                          "outline-none no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-primary",
                          "disabled:opacity-50 disabled:cursor-not-allowed",
                          selected
                            ? "bg-secondary text-primary"
                            : "bg-transparent text-secondary hover:bg-secondary/10",
                        )}
                      >
                        <span
                          className={cn(
                            "size-5 shrink-0 rounded-full border-2 flex items-center justify-center motion-safe:transition-all",
                            selected
                              ? "border-accent bg-accent text-primary"
                              : "border-secondary/50",
                          )}
                          aria-hidden="true"
                        >
                          <Check
                            size={12}
                            className={cn(
                              "motion-safe:transition-all",
                              selected ? "scale-100 opacity-100" : "scale-0 opacity-0",
                            )}
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-mono text-sm truncate">{album.name}</span>
                          {typeof album.item_count === "number" && (
                            <span className="block text-xs truncate">
                              {album.item_count} {album.item_count === 1 ? "item" : "items"}
                              {album.shared ? " · Shared" : ""}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          )}

          <div className="flex gap-3 justify-end pt-1">
            <Button
              variant="primary"
              surface="secondary"
              disabled={!selectedAlbum || albumsLoading || albums.length === 0}
              loading={adding}
              onClick={() => {
                if (!selectedAlbum) return;
                onAdd(selectedAlbum, close);
              }}
            >
              Add
            </Button>
            <Button
              variant="outline"
              surface="secondary"
              onClick={close}
              disabled={adding}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </ModalCard>
  );
}

AddToAlbumModal.propTypes = {
  open: PropTypes.bool.isRequired,
  albums: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      home_drive_id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      item_count: PropTypes.number,
      shared: PropTypes.bool,
    }),
  ),
  albumsLoading: PropTypes.bool,
  adding: PropTypes.bool,
  error: PropTypes.string,
  onAdd: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  overlayClassName: PropTypes.string,
};
