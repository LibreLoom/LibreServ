import { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon, Plus, PlugZap, Search } from "lucide-react";
import { Link } from "react-router-dom";
import Page from "../components/ui/Page";
import Button from "../components/ui/Button";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";
import SegmentedControl from "../components/common/SegmentedControl";
import ModalCard from "../components/cards/ModalCard";
import ConfirmModal from "../components/cards/ConfirmModal";
import CreateShareModal from "../components/files/CreateShareModal";
import PhotoTimeline from "../components/gallery/PhotoTimeline.jsx";
import PhotoLightbox from "../components/gallery/PhotoLightbox.jsx";
import PlacesMap from "../components/gallery/PlacesMap.jsx";
import {
  apiErrorMessage,
  deleteJson,
  getDrives,
  getJson,
  patchJson,
  postJson,
  putJson,
} from "../lib/api";

const SEGMENTS = [
  { value: "library", label: "Library" },
  { value: "albums", label: "Albums" },
  { value: "places", label: "Places" },
  { value: "favorites", label: "Favorites" },
];

function galleryUrl({ q, favorites, albumId, albumHome, place, offset }) {
  const params = new URLSearchParams();
  params.set("limit", "80");
  params.set("offset", String(offset || 0));
  if (q) params.set("q", q);
  if (favorites) params.set("favorites", "true");
  if (albumId) params.set("album_id", albumId);
  if (albumHome) params.set("album_home", albumHome);
  if (place) params.set("place", place);
  return `/api/v1/gallery?${params}`;
}

export default function GalleryPage() {
  const queryClient = useQueryClient();
  const [segment, setSegment] = useState("library");
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [place, setPlace] = useState(null);
  const [albumView, setAlbumView] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [sharePhoto, setSharePhoto] = useState(null);
  const [trashPhoto, setTrashPhoto] = useState(null);
  const [albumPick, setAlbumPick] = useState(null);
  const [newAlbumOpen, setNewAlbumOpen] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const galleryStatus = useQuery({
    queryKey: ["gallery-status"],
    queryFn: () => getJson("/api/v1/gallery/status"),
    refetchInterval: (query) => (query.state.data?.busy ? 1500 : 8000),
  });
  const albums = useQuery({
    queryKey: ["gallery-albums"],
    queryFn: () => getJson("/api/v1/gallery/albums"),
    enabled: segment === "albums" || !!albumPick,
  });
  const places = useQuery({
    queryKey: ["gallery-places"],
    queryFn: () => getJson("/api/v1/gallery/places"),
    enabled: segment === "places",
  });

  const listKey = useMemo(
    () => [
      "gallery",
      segment,
      search,
      place?.key || "",
      albumView ? `${albumView.home_drive_id}:${albumView.id}` : "",
    ],
    [segment, search, place, albumView],
  );

  const gallery = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getJson(
        galleryUrl({
          q: search || undefined,
          favorites: segment === "favorites",
          albumId: albumView?.id,
          albumHome: albumView?.home_drive_id,
          place: place?.key,
          offset: pageParam,
        }),
      ),
    getNextPageParam: (last) => (last?.has_more ? last.next_offset : undefined),
    enabled: segment !== "places" || !!place,
  });

  const photos = useMemo(
    () => (gallery.data?.pages || []).flatMap((p) => p.items || []),
    [gallery.data],
  );

  const indexing = !!galleryStatus.data?.busy;

  useEffect(() => {
    if (!indexing) return undefined;
    const id = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-places"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
    }, 2000);
    return () => clearInterval(id);
  }, [indexing, queryClient]);

  const driveList = drives.data || [];
  const looking = gallery.isLoading || (indexing && photos.length === 0);
  const noDrives = !drives.isLoading && driveList.length === 0;
  const noPhotos =
    !looking &&
    !gallery.isLoading &&
    photos.length === 0 &&
    driveList.length > 0 &&
    segment === "library" &&
    !search &&
    !place &&
    !albumView;

  const favorite = useMutation({
    /** @param {{ drive_id: string, path: string, favorited?: boolean }} photo */
    mutationFn: async (photo) => {
      const body = { drive_id: photo.drive_id, path: photo.path };
      if (photo.favorited) {
        await deleteJson("/api/v1/gallery/favorites", {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        await putJson("/api/v1/gallery/favorites", body);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["gallery"] }),
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const trash = useMutation({
    /** @param {{ drive_id: string, path: string }} photo */
    mutationFn: async (photo) => {
      await deleteJson(
        `/api/v1/drives/${photo.drive_id}/files?path=${encodeURIComponent(photo.path)}`,
      );
    },
    onSuccess: () => {
      setTrashPhoto(null);
      setLightbox(null);
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const createAlbum = useMutation({
    /** @param {string} name */
    mutationFn: (name) => postJson("/api/v1/gallery/albums", { name }),
    onSuccess: () => {
      setNewAlbumOpen(false);
      setNewAlbumName("");
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const addToAlbum = useMutation({
    /** @param {{ album: { home_drive_id: string, id: string }, photo: { drive_id: string, path: string } }} args */
    mutationFn: ({ album, photo }) =>
      postJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/items`, {
        items: [{ drive_id: photo.drive_id, path: photo.path }],
      }),
    onSuccess: () => {
      setAlbumPick(null);
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const openPhoto = useCallback(
    (photo) => {
      const idx = photos.findIndex(
        (p) => p.drive_id === photo.drive_id && p.path === photo.path,
      );
      setLightbox({ index: Math.max(0, idx) });
    },
    [photos],
  );

  const loadMore = useCallback(() => {
    if (gallery.hasNextPage && !gallery.isFetchingNextPage) {
      gallery.fetchNextPage();
    }
  }, [gallery]);

  function submitSearch(e) {
    e.preventDefault();
    setSearch(q.trim());
    setPlace(null);
    if (segment === "places") setSegment("library");
  }

  const showTimeline =
    segment === "library" ||
    segment === "favorites" ||
    (segment === "places" && place) ||
    (segment === "albums" && albumView);

  return (
    <Page
      title="Photos"
      titleId="gallery-title"
      bottomContent={
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SegmentedControl
            options={SEGMENTS}
            value={segment}
            onChange={(v) => {
              setSegment(v);
              setPlace(null);
              setAlbumView(null);
            }}
          />
          <form onSubmit={submitSearch} className="flex gap-2 grow max-w-md">
            <label className="sr-only" htmlFor="photo-search">
              Search photos
            </label>
            <div className="relative grow">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary"
                aria-hidden="true"
              />
              <input
                id="photo-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by name"
                className="w-full rounded-pill bg-secondary text-primary border-2 border-secondary/30 pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <Button type="submit" variant="secondary" surface="primary">
              Search
            </Button>
          </form>
        </div>
      }
    >
      {error && (
        <PageNotice variant="error" className="mb-4">
          {error}
        </PageNotice>
      )}

      {noDrives && (
        <EmptyState
          icon={PlugZap}
          title="No drives to look in"
          description="Plug in a drive and add it on the Drives page. Luna will then look through it for photos."
          action={
            <Button variant="primary" asChild>
              <Link to="/drives">Go to Drives</Link>
            </Button>
          }
        />
      )}

      {looking && photos.length === 0 && !noDrives && segment === "library" && (
        <div className="rounded-large-element bg-secondary text-primary p-6 mb-4">
          <p className="font-mono text-sm">Looking through your drives</p>
          <p className="mt-2 text-sm">
            Luna is finding photos in the background. Previews stay on your drive
            — not on Luna&apos;s internal storage. Originals stay exactly where they are.
          </p>
        </div>
      )}

      {noPhotos && (
        <EmptyState
          icon={ImageIcon}
          title="No photos yet"
          description="Luna looks through your drives automatically. Add pictures to a drive and they will show up here."
        />
      )}

      {segment === "albums" && !albumView && (
        <AlbumsPanel
          albums={albums.data || []}
          loading={albums.isLoading}
          onOpen={setAlbumView}
          onCreate={() => setNewAlbumOpen(true)}
          onShare={async (album) => {
            try {
              await patchJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}`, {
                shared: true,
                allow_uploads: true,
              });
              const invite = await postJson(
                `/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/invites`,
                { role: "contributor" },
              );
              const url = `${window.location.origin}${invite.url}`;
              try {
                await navigator.clipboard?.writeText(url);
              } catch {
                // clipboard may be blocked
              }
              setError(null);
              window.alert(`Invite link copied:\n${url}`);
              queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
            } catch (err) {
              setError(apiErrorMessage(err));
            }
          }}
        />
      )}

      {segment === "places" && !place && (
        <PlacesMap
          places={places.data || []}
          onSelect={(p) => {
            setPlace(p);
            setSegment("places");
          }}
        />
      )}

      {(place || albumView) && (
        <div className="mb-4 flex items-center gap-3">
          <Button
            variant="outline"
            surface="primary"
            onClick={() => {
              setPlace(null);
              setAlbumView(null);
            }}
          >
            Back
          </Button>
          <p className="font-mono text-sm">
            {place?.label || albumView?.name}
          </p>
        </div>
      )}

      {showTimeline && photos.length > 0 && (
        <PhotoTimeline
          photos={photos}
          hasMore={!!gallery.hasNextPage}
          loadingMore={gallery.isFetchingNextPage}
          onLoadMore={loadMore}
          onOpen={openPhoto}
        />
      )}

      {lightbox && (
        <PhotoLightbox
          photos={photos}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(i) => setLightbox({ index: i })}
          onFavorite={(p) => favorite.mutate(p)}
          onShare={setSharePhoto}
          onAlbum={setAlbumPick}
          onTrash={setTrashPhoto}
          favoriting={favorite.isPending}
        />
      )}

      {sharePhoto && (
        <CreateShareModal
          driveId={sharePhoto.drive_id}
          path={sharePhoto.path}
          onClose={() => setSharePhoto(null)}
          onDone={() => setSharePhoto(null)}
          onError={setError}
        />
      )}

      <ConfirmModal
        open={!!trashPhoto}
        onClose={() => setTrashPhoto(null)}
        onConfirm={() => trashPhoto && trash.mutate(trashPhoto)}
        title="Move to trash?"
        message="Luna will move this file to Trash on its drive. You can restore it from Files later."
        variant="danger-undoable"
        confirmLabel="Move to trash"
        loading={trash.isPending}
      />

      {newAlbumOpen && (
        <ModalCard title="New album" onClose={() => setNewAlbumOpen(false)}>
          {({ close }) => (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                createAlbum.mutate(newAlbumName.trim());
              }}
            >
              <label className="block text-sm">
                Album name
                <input
                  value={newAlbumName}
                  onChange={(e) => setNewAlbumName(e.target.value)}
                  className="mt-1 w-full rounded-large-element bg-primary text-secondary border-2 border-secondary/30 px-3 py-2"
                  autoFocus
                  required
                />
              </label>
              <div className="flex gap-2">
                <Button type="submit" variant="accent" loading={createAlbum.isPending}>
                  Create
                </Button>
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </ModalCard>
      )}

      {albumPick && (
        <ModalCard title="Add to album" onClose={() => setAlbumPick(null)}>
          {({ close }) => (
            <div className="space-y-2">
              {(albums.data || []).length === 0 && (
                <p className="text-sm">Create an album first, then add photos to it.</p>
              )}
              {(albums.data || []).map((album) => (
                <Button
                  key={album.id}
                  variant="outline"
                  fullWidth
                  onClick={() => addToAlbum.mutate({ album, photo: albumPick })}
                >
                  {album.name}
                </Button>
              ))}
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
            </div>
          )}
        </ModalCard>
      )}
    </Page>
  );
}

function AlbumsPanel({ albums, loading, onOpen, onCreate, onShare }) {
  if (loading) {
    return <p className="text-secondary text-sm">Loading albums…</p>;
  }
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="secondary" surface="primary" onClick={onCreate}>
          <Plus size={16} /> New album
        </Button>
      </div>
      {albums.length === 0 ? (
        <EmptyState
          icon={ImageIcon}
          title="No albums yet"
          description="Create an album to group photos, or share one so others can add pictures too."
          action={
            <Button variant="primary" onClick={onCreate}>
              New album
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {albums.map((album) => (
            <div
              key={`${album.home_drive_id}-${album.id}`}
              className="rounded-large-element bg-secondary text-primary overflow-hidden"
            >
              <button type="button" className="block w-full text-left" onClick={() => onOpen(album)}>
                <div className="aspect-square bg-primary text-secondary">
                  {album.cover_thumb ? (
                    <img src={album.cover_thumb} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full items-center justify-center">
                      <ImageIcon size={24} />
                    </span>
                  )}
                </div>
                <div className="p-3">
                  <p className="font-mono text-sm truncate">{album.name}</p>
                  <p className="text-xs mt-1">
                    {album.item_count} {album.item_count === 1 ? "item" : "items"}
                    {album.shared ? " · Shared" : ""}
                  </p>
                </div>
              </button>
              <div className="px-3 pb-3">
                <Button variant="outline" size="sm" fullWidth onClick={() => onShare(album)}>
                  Share album
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

AlbumsPanel.propTypes = {
  albums: PropTypes.array,
  loading: PropTypes.bool,
  onOpen: PropTypes.func,
  onCreate: PropTypes.func,
  onShare: PropTypes.func,
};

