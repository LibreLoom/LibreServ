import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon, Upload } from "lucide-react";
import Page from "../components/ui/Page";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";
import ShakeTarget from "../components/ui/ShakeTarget";
import PhotoThumb from "../components/gallery/PhotoThumb.jsx";
import PhotoLightbox from "../components/gallery/PhotoLightbox.jsx";
import { apiErrorMessage, getJson, postForm } from "../lib/api";

/** Guest shared-album page — browse + optional upload without signing in. */
export default function PublicAlbumPage() {
  const { token } = useParams();
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [lightbox, setLightbox] = useState(null);

  const album = useQuery({
    queryKey: ["public-album", token],
    queryFn: () => getJson(`/api/v1/public/albums/${token}`),
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

  const items = album.data?.items || [];
  const title = album.data?.album?.name || "Shared album";

  return (
    <div className="min-h-screen bg-primary text-secondary">
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
        {album.data && (
          <>
            <p className="mb-4 text-sm">
              {items.length} {items.length === 1 ? "item" : "items"}
              {album.data.can_upload ? " · You can add photos and videos" : ""}
            </p>
            {album.data.can_upload && (
              <div className="mb-6">
                <ShakeTarget shake={error}>
                  <label className="inline-flex cursor-pointer">
                    <span className="inline-flex items-center gap-2 rounded-pill bg-secondary text-primary px-4 py-2 text-sm">
                      <Upload size={16} aria-hidden="true" />
                      {upload.isPending ? "Uploading…" : "Add photos"}
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
              </div>
            )}
            {items.length === 0 ? (
              <EmptyState
                icon={ImageIcon}
                title="No photos yet"
                description={
                  album.data.can_upload
                    ? "Be the first to add a photo or video to this album."
                    : "Nothing has been added to this album yet."
                }
              />
            ) : (
              <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5">
                {items.map((photo, index) => (
                  <PhotoThumb
                    key={`${photo.drive_id}/${photo.path}`}
                    photo={photo}
                    onClick={() => setLightbox({ index })}
                  />
                ))}
              </div>
            )}
          </>
        )}
        {lightbox && (
          <PhotoLightbox
            photos={items}
            index={lightbox.index}
            onClose={() => setLightbox(null)}
            onIndexChange={(i) => setLightbox({ index: i })}
          />
        )}
      </Page>
    </div>
  );
}
