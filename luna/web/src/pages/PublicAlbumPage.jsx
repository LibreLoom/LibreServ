import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Image as ImageIcon, Upload } from "lucide-react";
import Page from "../components/ui/Page";
import Button from "../components/ui/Button";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";
import ShakeTarget from "../components/ui/ShakeTarget";
import PhotoThumb from "../components/gallery/PhotoThumb.jsx";
import PhotoLightbox, {
  resolveDisplaySrc,
  resolveDownloadSrc,
} from "../components/gallery/PhotoLightbox.jsx";
import { apiErrorMessage, getJson, postForm } from "../lib/api";
import { photoSelectionKey } from "../hooks/useMultiSelect.js";

/**
 * Guest shared-album page — browse + optional upload without signing in.
 */
export default function PublicAlbumPage() {
  const { token } = useParams();
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [lightbox, setLightbox] = useState(/** @type {{ key: string }|null} */ (null));
  const dropRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const [dragOver, setDragOver] = useState(false);

  const album = useInfiniteQuery({
    queryKey: ["public-album", token],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set("limit", "80");
      params.set("offset", String(pageParam || 0));
      return getJson(`/api/v1/public/albums/${token}?${params}`);
    },
    getNextPageParam: (last) => {
      if (last?.has_more) return last.next_offset ?? (last.items?.length || 0);
      return undefined;
    },
  });

  const upload = useMutation({
    /** @param {File[]} files */
    mutationFn: async (files) => {
      const form = new FormData();
      for (const file of files) form.append("file", file);
      return postForm(`/api/v1/public/albums/${token}/upload`, form);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["public-album", token] });
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const pages = album.data?.pages || [];
  const first = pages[0];
  const items = useMemo(() => pages.flatMap((p) => p.items || []), [pages]);
  const title = first?.album?.name || "Shared album";
  const canUpload = !!first?.can_upload;
  const hasMore = !!album.hasNextPage;

  const loadMore = useCallback(() => {
    if (album.hasNextPage && !album.isFetchingNextPage) album.fetchNextPage();
  }, [album]);

  const sentinel = useRef(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, items.length]);

  useEffect(() => {
    if (!canUpload) return undefined;
    function onDragOver(e) {
      e.preventDefault();
      setDragOver(true);
    }
    function onDragLeave() {
      setDragOver(false);
    }
    function onDrop(e) {
      e.preventDefault();
      setDragOver(false);
      const files = [...(e.dataTransfer?.files || [])].filter(
        (f) => f.type.startsWith("image/") || f.type.startsWith("video/"),
      );
      if (files.length) upload.mutate(files);
    }
    const node = dropRef.current;
    if (!node) return undefined;
    node.addEventListener("dragover", onDragOver);
    node.addEventListener("dragleave", onDragLeave);
    node.addEventListener("drop", onDrop);
    return () => {
      node.removeEventListener("dragover", onDragOver);
      node.removeEventListener("dragleave", onDragLeave);
      node.removeEventListener("drop", onDrop);
    };
  }, [canUpload, upload]);

  const lightboxIndex = lightbox
    ? Math.max(0, items.findIndex((p) => photoSelectionKey(p) === lightbox.key))
    : 0;
  const lightboxPhoto = items[lightboxIndex];

  function guestContentSrc(photo) {
    if (photo?.content) return photo.content;
    if (photo?.drive_id && photo?.path) {
      return `/api/v1/public/albums/${token}/content?drive_id=${encodeURIComponent(photo.drive_id)}&path=${encodeURIComponent(photo.path)}`;
    }
    return photo?.thumb || "";
  }

  function guestDownloadSrc(photo) {
    if (photo?.download) return photo.download;
    if (photo?.drive_id && photo?.path) {
      return `/api/v1/public/albums/${token}/download?drive_id=${encodeURIComponent(photo.drive_id)}&path=${encodeURIComponent(photo.path)}`;
    }
    return photo?.thumb || "";
  }

  return (
    <div className="min-h-screen bg-primary text-secondary" ref={dropRef}>
      <Page title={title} titleId="public-album-title">
        {error && (
          <PageNotice variant="error" className="mb-4">
            {error}
          </PageNotice>
        )}
        {album.isError && (
          <EmptyState
            icon={ImageIcon}
            title="Link not valid"
            description="This shared album link is not valid or has expired. Ask the owner for a new link."
          />
        )}
        {album.isLoading && <p className="text-sm">Opening album…</p>}
        {first && (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                {items.length} {items.length === 1 ? "item" : "items"}
                {canUpload ? " · You can add photos and videos" : " · View only"}
                {hasMore ? " · More available" : ""}
              </p>
              <Button
                variant="secondary"
                surface="primary"
                size="sm"
                asChild
              >
                <a href={`/api/v1/public/albums/${token}/zip`}>
                  <Download size={16} />
                  Download album
                </a>
              </Button>
            </div>
            {canUpload && (
              <div className="mb-6">
                <ShakeTarget shake={error}>
                  <label
                    className={`inline-flex cursor-pointer ${
                      dragOver ? "ring-2 ring-accent rounded-pill" : ""
                    }`}
                  >
                    <span className="inline-flex items-center gap-2 rounded-pill bg-secondary text-primary px-4 py-2 text-sm">
                      <Upload size={16} aria-hidden="true" />
                      {upload.isPending
                        ? "Uploading…"
                        : dragOver
                          ? "Drop to add"
                          : "Add photos"}
                    </span>
                    <input
                      type="file"
                      accept="image/*,video/*"
                      multiple
                      className="sr-only"
                      disabled={upload.isPending}
                      onChange={(e) => {
                        const files = [...(e.target.files || [])];
                        if (files.length) upload.mutate(files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </ShakeTarget>
                <p className="mt-2 text-sm">
                  Or drag photos onto this page to add them.
                </p>
              </div>
            )}
            {items.length === 0 ? (
              <EmptyState
                icon={ImageIcon}
                title="No photos yet"
                description={
                  canUpload
                    ? "Be the first to add a photo or video to this album."
                    : "Nothing has been added to this album yet."
                }
              />
            ) : (
              <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5">
                {items.map((photo, index) => (
                  <PhotoThumb
                    key={photoSelectionKey(photo) || `${photo.drive_id}/${photo.path}`}
                    photo={photo}
                    index={index}
                    onOpen={() => setLightbox({ key: photoSelectionKey(photo) })}
                  />
                ))}
              </div>
            )}
            <div ref={sentinel} className="h-8" aria-hidden="true" />
            {album.isFetchingNextPage && (
              <p className="py-4 text-center font-mono text-sm">Loading more…</p>
            )}
          </>
        )}
        {lightbox && lightboxPhoto && (
          <PhotoLightbox
            mode="guest"
            photos={items}
            photoKey={lightbox.key}
            index={lightboxIndex}
            contentSrc={resolveDisplaySrc(lightboxPhoto, {
              contentSrc: guestContentSrc(lightboxPhoto),
            })}
            downloadSrc={resolveDownloadSrc(lightboxPhoto, {
              downloadSrc: guestDownloadSrc(lightboxPhoto),
            })}
            onClose={() => setLightbox(null)}
            onIndexChange={(i) => {
              const next = items[i];
              if (next) setLightbox({ key: photoSelectionKey(next) });
            }}
          />
        )}
      </Page>
    </div>
  );
}
