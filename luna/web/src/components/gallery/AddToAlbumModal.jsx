/* eslint-disable react-refresh/only-export-components -- albumKey shared with GalleryPage tests */
import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Check, Minus, Search } from "lucide-react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ModalErrorNotice from "@libreloom/ui/components/common/ModalErrorNotice.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { getJson } from "../../lib/api";
import { photoSelectionKey } from "../../hooks/useMultiSelect.js";

/**
 * @param {{ home_drive_id: string, id: string }} album
 */
export function albumKey(album) {
  return `${album.home_drive_id}:${album.id}`;
}

/**
 * Edit which albums the selected photos belong to. Every album renders as a
 * single-line pill with a tri-state check: checked = every selected photo is
 * in it, mixed = some are, unchecked = none. Toggling drafts the change;
 * "Apply" adds and removes items to match.
 *
 * @param {{
 *   open: boolean,
 *   albums?: Array<{ id: string, home_drive_id: string, name: string, item_count?: number, shared?: boolean }>,
 *   photos?: Array<{ drive_id: string, path: string }>,
 *   albumsLoading?: boolean,
 *   applying?: boolean,
 *   error?: string | null,
 *   onApply: (changes: Array<{ album: object, add?: object[], remove?: object[] }>, close: () => void) => void,
 *   onClose: () => void,
 *   overlayClassName?: string,
 * }} props
 */
export default function AddToAlbumModal({
  open,
  albums = [],
  photos = [],
  albumsLoading = false,
  applying = false,
  error = null,
  onApply,
  onClose,
  overlayClassName,
}) {
  const [query, setQuery] = useState("");
  const [overrides, setOverrides] = useState(() => new Map());
  const [membership, setMembership] = useState(/** @type {Map<string, Set<string>> | null} */ (null));
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState(null);
  const searchRef = useRef(/** @type {HTMLInputElement|null} */ (null));

  const photoKeys = useMemo(() => photos.map(photoSelectionKey), [photos]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset draft UI when the modal opens
    setQuery("");
    setOverrides(new Map());
    setMembershipError(null);
    if (!albums.length || !photos.length) {
      setMembership(new Map());
      return;
    }
    let cancelled = false;
    setMembershipLoading(true);
    Promise.allSettled(
      albums.map(async (album) => {
        const items = await getJson(
          `/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/items`,
        );
        return /** @type {[string, Set<string>]} */ ([
          albumKey(album),
          new Set((items || []).map(photoSelectionKey)),
        ]);
      }),
    )
      .then((results) => {
        if (cancelled) return;
        const entries = /** @type {Array<[string, Set<string>]>} */ ([]);
        const failures = [];
        for (const r of results) {
          if (r.status === "fulfilled") entries.push(r.value);
          else failures.push(r.reason);
        }
        setMembership(new Map(entries));
        if (failures.length) {
          setMembershipError(
            "Luna couldn't check every album — some albums may not show what is already inside.",
          );
        }
        setMembershipLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMembership(new Map());
        setMembershipLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, albums, photos]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return albums;
    return albums.filter((album) => album.name.toLowerCase().includes(needle));
  }, [albums, query]);

  /** How many of the selected photos an album already holds. */
  const inCount = (key) => {
    const refs = membership?.get(key);
    if (!refs) return 0;
    return photoKeys.filter((k) => refs.has(k)).length;
  };

  /** "checked" | "mixed" | "unchecked" — what the pill should display. */
  const stateFor = (key) => {
    if (overrides.has(key)) return overrides.get(key) ? "checked" : "unchecked";
    const n = inCount(key);
    if (n === 0) return "unchecked";
    return n >= photoKeys.length ? "checked" : "mixed";
  };

  const toggle = (key) => {
    haptic("selection");
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(key, stateFor(key) !== "checked");
      return next;
    });
  };

  const changes = useMemo(() => {
    const list = [];
    for (const album of albums) {
      const key = albumKey(album);
      if (!overrides.has(key)) continue;
      const refs = membership?.get(key) || new Set();
      const want = overrides.get(key);
      const add = photos.filter((p) => !refs.has(photoSelectionKey(p)));
      const remove = photos.filter((p) => refs.has(photoSelectionKey(p)));
      if (want && add.length) list.push({ album, add });
      if (!want && remove.length) list.push({ album, remove });
    }
    return list;
  }, [albums, overrides, membership, photos]);

  const rowsDisabled = applying || membershipLoading;

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
          <ModalErrorNotice error={error || membershipError} />

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
                <span className="block translate-x-5">Find an album</span>
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
                    disabled={applying}
                    className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 pl-11 pr-4 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
                  />
                </div>
              </label>

              <div
                role="group"
                aria-label="Albums"
                className="max-h-64 overflow-y-auto overscroll-contain space-y-1 rounded-large-element bg-primary text-secondary p-2 border-2 border-secondary/20"
              >
                {filtered.length === 0 ? (
                  <p className="px-3 py-4 text-sm text-secondary">
                    No albums match “{query.trim()}”. Try another name.
                  </p>
                ) : (
                  filtered.map((album) => {
                    const key = albumKey(album);
                    const state = stateFor(key);
                    const checked = state === "checked";
                    return (
                      <button
                        key={key}
                        type="button"
                        role="checkbox"
                        aria-checked={state === "mixed" ? "mixed" : checked}
                        disabled={rowsDisabled}
                        onClick={() => toggle(key)}
                        className={cn(
                          "w-full flex items-center gap-2.5 rounded-pill px-3 py-1.5 text-left motion-safe:transition-colors",
                          "outline-none no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-primary",
                          "disabled:opacity-50 disabled:cursor-not-allowed",
                          checked
                            ? "bg-secondary/10 hover:bg-secondary/20"
                            : "bg-transparent hover:bg-secondary/10",
                        )}
                      >
                        <span
                          className={cn(
                            "size-5 shrink-0 rounded-full border-2 flex items-center justify-center motion-safe:transition-all",
                            checked || state === "mixed"
                              ? "border-accent bg-accent text-primary"
                              : "border-secondary/50",
                          )}
                          aria-hidden="true"
                        >
                          {checked ? (
                            <Check size={12} />
                          ) : state === "mixed" ? (
                            <Minus size={12} />
                          ) : null}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-mono text-sm">{album.name}</span>
                          <span className="font-mono text-xs">
                            {typeof album.item_count === "number"
                              ? ` · ${album.item_count} ${album.item_count === 1 ? "item" : "items"}`
                              : ""}
                            {album.shared ? " · Shared" : ""}
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
              {membershipLoading && (
                <p className="flex items-center gap-2 text-xs text-primary" role="status">
                  <Spinner size="sm" decorative /> Checking what is already inside…
                </p>
              )}
            </>
          )}

          <div className="flex gap-3 justify-end pt-1">
            <Button
              variant="primary"
              surface="secondary"
              disabled={
                changes.length === 0 || albumsLoading || albums.length === 0 || membershipLoading
              }
              loading={applying}
              onClick={() => {
                if (!changes.length) return;
                onApply(changes, close);
              }}
            >
              Apply
            </Button>
            <Button
              variant="outline"
              surface="secondary"
              onClick={close}
              disabled={applying}
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
  photos: PropTypes.arrayOf(
    PropTypes.shape({
      drive_id: PropTypes.string,
      path: PropTypes.string,
    }),
  ),
  albumsLoading: PropTypes.bool,
  applying: PropTypes.bool,
  error: PropTypes.string,
  onApply: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  overlayClassName: PropTypes.string,
};
