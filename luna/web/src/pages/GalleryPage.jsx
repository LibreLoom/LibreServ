import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon, PlugZap } from "lucide-react";
import { Link } from "react-router-dom";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";
import TextLink from "../components/ui/TextLink";
import { getDrives, getJson, postJson } from "../lib/api";

function dateLabel(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export default function GalleryPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const autoScanStarted = useRef(false);
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const gallery = useQuery({
    queryKey: ["gallery"],
    queryFn: () => getJson("/api/v1/gallery"),
    refetchInterval: scan.isPending ? 2000 : false,
  });

  const scan = useMutation({
    mutationFn: () => postJson("/api/v1/gallery/scan", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
    },
    onError: (err) => setError(String(err.message || err)),
  });

  const driveList = drives.data || [];
  const photos = gallery.data || [];
  const looking = gallery.isLoading || scan.isPending;
  const noDrives = !drives.isLoading && driveList.length === 0;
  const noPhotos = !looking && !gallery.isLoading && photos.length === 0 && driveList.length > 0;

  useEffect(() => {
    if (autoScanStarted.current) return;
    if (gallery.isLoading || drives.isLoading) return;
    if (photos.length > 0) return;
    if (driveList.length === 0) return;
    autoScanStarted.current = true;
    scan.mutate();
    // scan.mutate is stable enough for this one-shot kickoff
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gallery.isLoading, drives.isLoading, photos.length, driveList.length]);

  const driveLabel = (id) => driveList.find((d) => d.id === id)?.label;

  return (
    <Page title="Photos" titleId="gallery-title">
      {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}

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

      {looking && photos.length === 0 && !noDrives && (
        <Card icon={ImageIcon} title="Looking through your drives">
          <p className="text-primary text-sm">
            Luna builds the gallery in the background. It reads your photos
            from every drive you can see (including phone HEIC files), makes
            small previews, and sorts them by the date they were taken when
            the photo has that date. Originals stay exactly where they are.
          </p>
        </Card>
      )}

      {noPhotos && (
        <EmptyState
          icon={ImageIcon}
          title="No photos yet"
          description="Luna looked through your drives and did not find pictures. If you just added photos, look again."
          action={
            <Button variant="primary" loading={scan.isPending} onClick={() => scan.mutate()}>
              Look again
            </Button>
          }
        />
      )}

      <div className="columns-2 md:columns-3 lg:columns-4 gap-4">
        {photos.map((photo) => (
          <Card
            key={`${photo.drive_id}/${photo.path}`}
            noHeightAnim
            noPopIn
            padding={false}
            className="mb-4 break-inside-avoid overflow-hidden"
          >
            <a
              href={`/api/v1/drives/${photo.drive_id}/files/content?path=${encodeURIComponent(photo.path)}`}
              target="_blank"
              rel="noreferrer"
              className="block motion-safe:transition-colors hover:opacity-95"
            >
              {photo.thumb ? (
                <img src={photo.thumb} alt={photo.name} loading="lazy" className="w-full block" />
              ) : (
                <div className="h-40 flex items-center justify-center text-primary">
                  <ImageIcon size={24} aria-hidden="true" />
                </div>
              )}
            </a>
            <div className="p-2">
              <p className="text-primary font-mono text-xs truncate">{photo.name}</p>
              <p className="text-primary text-xs">
                {[driveLabel(photo.drive_id), dateLabel(photo.taken_at)].filter(Boolean).join(" · ")}
              </p>
              <p className="mt-1">
                <TextLink
                  surface="secondary"
                  to={`/drives/${photo.drive_id}?path=${encodeURIComponent((photo.path || "").split("/").slice(0, -1).join("/"))}`}
                >
                  Open folder
                </TextLink>
              </p>
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}
