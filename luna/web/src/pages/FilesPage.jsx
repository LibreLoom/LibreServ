import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { ArrowLeft, Download, File as FileIcon, Folder, UploadCloud } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import TextLink from "../components/ui/TextLink";
import { getDrives, getJson } from "../lib/api";

function fmtSize(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1000 * 1000 * 1000) return `${(bytes / 1000 / 1000).toFixed(1)} MB`;
  return `${(bytes / 1000 / 1000 / 1000).toFixed(1)} GB`;
}

function joinPath(base, name) {
  return base ? `${base}/${name}` : name;
}

function parentPath(path) {
  if (!path) return null;
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

export default function FilesPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const drive = (drives.data || []).find((d) => d.id === id);

  const files = useQuery({
    queryKey: ["files", id, path],
    queryFn: () => getJson(`/api/v1/drives/${id}/files?path=${encodeURIComponent(path)}`),
    enabled: !!drive,
  });

  const upload = useMutation({
    mutationFn: async (/** @type {File} */ file) => {
      const form = new FormData();
      form.append("path", path);
      form.append("file", file);
      const res = await fetch(`/api/v1/drives/${id}/files/upload?path=${encodeURIComponent(path)}`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Upload failed");
      }
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["files", id, path] }),
    onError: (err) => setUploadError(String(err)),
  });

  async function onDrop(event) {
    event.preventDefault();
    setDragOver(false);
    setUploadError(null);
    const dropped = Array.from(event.dataTransfer?.files || []);
    for (const file of dropped) {
      upload.mutate(file);
    }
  }

  const up = parentPath(path);

  return (
    <Page
      title={drive ? drive.label : "Files"}
      titleId="files-title"
      leftContent={<TextLink to="/drives"><ArrowLeft size={16} className="inline mr-1" />Drives</TextLink>}
    >
      <div className="flex items-center gap-2 font-mono text-xs text-secondary mb-4">
        <button type="button" className="hover:text-accent" onClick={() => setPath("")}>
          {drive?.label || "Drive"}
        </button>
        {path.split("/").filter(Boolean).map((segment, i, all) => (
          <span key={`${segment}-${i}`}>
            <span className="text-accent">/</span>
            <button
              type="button"
              className="hover:text-accent"
              onClick={() => setPath(all.slice(0, i + 1).join("/"))}
            >
              {segment}
            </button>
          </span>
        ))}
      </div>

      {up !== null && (
        <Button variant="outline" size="sm" className="mb-4" onClick={() => setPath(up)}>
          ↑ Up one folder
        </Button>
      )}

      <div
        className={`mb-6 rounded-large-element border-2 border-dashed p-6 text-center ${
          dragOver ? "border-accent bg-secondary/10" : "border-secondary/30"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <UploadCloud size={20} className="text-accent mx-auto mb-2" />
        <p className="text-secondary text-sm">
          Drop files here to put them in this folder
        </p>
        <p className="text-secondary/70 text-xs mt-1">Luna saves to this drive with a full safety check.</p>
        {uploadError && <p className="text-error text-xs mt-2">{uploadError}</p>}
        {upload.isPending && <p className="text-secondary text-xs mt-2">Saving…</p>}
      </div>

      <div className="grid gap-3">
        {(files.data || [])
          .filter((entry) => !entry.hidden)
          .map((entry) => (
            <Card key={entry.name} padding={false} noPopIn noHeightAnim>
              <div className="flex items-center justify-between p-4">
                <button
                  type="button"
                  className="flex items-center gap-3 text-left flex-1 min-w-0"
                  onClick={() => entry.kind === "dir" && setPath(joinPath(path, entry.name))}
                  disabled={entry.kind !== "dir"}
                >
                  {entry.kind === "dir" ? (
                    <Folder size={18} className="text-accent shrink-0" />
                  ) : (
                    <FileIcon size={18} className="text-accent shrink-0" />
                  )}
                  <span className="text-primary font-mono text-sm truncate">{entry.name}</span>
                </button>
                <span className="text-primary text-xs w-20 text-right">{fmtSize(entry.size)}</span>
                {entry.kind === "file" && (
                  <a
                    className="ml-4 text-primary hover:text-accent"
                    href={`/api/v1/drives/${id}/files/content?path=${encodeURIComponent(joinPath(path, entry.name))}&download=1`}
                    aria-label={`Download ${entry.name}`}
                  >
                    <Download size={16} />
                  </a>
                )}
              </div>
            </Card>
          ))}
      </div>
      {!files.isLoading && (files.data || []).filter((e) => !e.hidden).length === 0 && (
        <p className="text-secondary text-sm mt-4">This folder is empty. Drop files above.</p>
      )}
    </Page>
  );
}
