import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import Dropdown from "../components/common/Dropdown";
import PageNotice from "../components/common/PageNotice";
import { getDrives, getJson, postJson } from "../lib/api";

function dateLabel(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export default function GalleryPage() {
  const queryClient = useQueryClient();
  const [driveId, setDriveId] = useState("");
  const [error, setError] = useState(null);
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });

  const gallery = useQuery({
    queryKey: ["gallery", driveId],
    queryFn: () => getJson(`/api/v1/gallery?drive_id=${encodeURIComponent(driveId)}`),
    enabled: !!driveId,
  });

  const scan = useMutation({
    mutationFn: () => postJson("/api/v1/gallery/scan", { drive_id: driveId }),
    onSuccess: () => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["gallery", driveId] }), 1500);
    },
    onError: (err) => setError(String(err)),
  });

  return (
    <Page title="Photos" titleId="gallery-title"
      rightContent={
        <div className="w-56">
          <Dropdown
            options={(drives.data || []).map((d) => ({ value: d.id, label: d.label }))}
            value={driveId}
            onChange={setDriveId}
            placeholder="Choose a drive"
            fullWidth
          />
        </div>
      }
    >
      {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}
      {driveId && (gallery.data || []).length === 0 && !gallery.isLoading && (
        <Card icon={ImageIcon} title="No photos yet">
          <p className="text-primary text-sm">
            Luna builds the gallery in the background. It reads your files and
            makes small previews — the originals stay exactly where they are.
          </p>
          <div className="mt-3">
            <Button variant="primary" loading={scan.isPending} onClick={() => scan.mutate()}>Build my gallery</Button>
          </div>
        </Card>
      )}

      <div className="columns-2 md:columns-3 lg:columns-4 gap-4">
        {(gallery.data || []).map((photo) => (
          <Card
            key={`${photo.drive_id}/${photo.path}`}
            as="a"
            noHeightAnim
            noPopIn
            padding={false}
            className="block mb-4 break-inside-avoid overflow-hidden motion-safe:transition-colors hover:ring-2 hover:ring-accent"
            href={`/api/v1/drives/${photo.drive_id}/files/content?path=${encodeURIComponent(photo.path)}`}
            target="_blank"
            rel="noreferrer"
          >
            {photo.thumb ? (
              <img src={photo.thumb} alt={photo.name} loading="lazy" className="w-full block" />
            ) : (
              <div className="h-40 flex items-center justify-center text-accent">
                <ImageIcon size={24} aria-hidden="true" />
              </div>
            )}
            <div className="p-2">
              <p className="text-primary font-mono text-xs truncate">{photo.name}</p>
              <p className="text-accent text-xs">{dateLabel(photo.taken_at)}</p>
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}
