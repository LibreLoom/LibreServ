import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Download, File as FileIcon, Folder, Pencil, Trash2, UploadCloud } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import Button from "../components/ui/Button";
import { getDrives, getJson } from "../lib/api";

const CHUNK_SIZE = 8 * 1024 * 1024;
const MULTIPART_LIMIT = 32 * 1024 * 1024;

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

function folderHref(driveId, folderPath) {
  if (!folderPath) return `/drives/${driveId}`;
  return `/drives/${driveId}?path=${encodeURIComponent(folderPath)}`;
}

async function parseError(res) {
  try {
    const data = await res.json();
    return data.error || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export default function FilesPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  // Folder location lives in the address bar so refresh, Back, and
  // "Shared with me" links (`?path=`) all land on the same folder.
  const path = searchParams.get("path") || "";
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const drive = (drives.data || []).find((d) => d.id === id);

  const files = useQuery({
    queryKey: ["files", id, path],
    queryFn: () => getJson(`/api/v1/drives/${id}/files?path=${encodeURIComponent(path)}`),
    enabled: !!drive,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["files", id, path] });

  async function uploadMultipart(file) {
    const form = new FormData();
    form.append("path", path);
    form.append("file", file);
    const res = await fetch(`/api/v1/drives/${id}/files/upload?path=${encodeURIComponent(path)}`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    if (!res.ok) throw new Error(await parseError(res));
    return res.json();
  }

  async function uploadChunked(file) {
    const created = await fetch("/api/v1/uploads", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drive_id: id, path, name: file.name, size: file.size }),
    });
    if (!created.ok) throw new Error(await parseError(created));
    const session = await created.json();
    let received = 0;
    for (let start = 0; start < file.size; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, file.size) - 1;
      const chunk = file.slice(start, end + 1);
      const put = await fetch(`/api/v1/uploads/${session.upload_id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Range": `bytes ${start}-${end}/${file.size}` },
        body: chunk,
      });
      if (!put.ok) throw new Error(await parseError(put));
      const progress = await put.json();
      received = progress.received;
      setUploading({ name: file.name, received, size: file.size });
    }
    const done = await fetch(`/api/v1/uploads/${session.upload_id}/complete`, {
      method: "POST",
      credentials: "include",
    });
    if (!done.ok) throw new Error(await parseError(done));
    return done.json();
  }

  async function uploadOne(file) {
    setUploadError(null);
    setUploading({ name: file.name, received: 0, size: file.size });
    try {
      if (file.size <= MULTIPART_LIMIT) {
        await uploadMultipart(file);
      } else {
        await uploadChunked(file);
      }
      invalidate();
    } catch (err) {
      setUploadError(String(err));
    } finally {
      setUploading(null);
    }
  }

  async function onDrop(event) {
    event.preventDefault();
    setDragOver(false);
    const dropped = Array.from(event.dataTransfer?.files || []);
    for (const file of dropped) {
      await uploadOne(file);
    }
  }

  const removeMutation = useMutation({
    mutationFn: async (/** @type {any} */ entry) => {
      const res = await fetch(
        `/api/v1/drives/${id}/files?path=${encodeURIComponent(joinPath(path, entry.name))}`,
        { method: "DELETE", credentials: "include" }
      );
      if (!res.ok) throw new Error(await parseError(res));
      return res.json();
    },
    onSuccess: () => { setDeleteTarget(null); invalidate(); },
    onError: (err) => setUploadError(String(err)),
  });

  const renameMutation = useMutation({
    mutationFn: async (/** @type {{ entry: any, newName: string }} */ { entry, newName }) => {
      const res = await fetch(`/api/v1/drives/${id}/files/rename`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: joinPath(path, entry.name), new_name: newName }),
      });
      if (!res.ok) throw new Error(await parseError(res));
      return res.json();
    },
    onSuccess: () => { setRenameTarget(null); invalidate(); },
    onError: (err) => setUploadError(String(err)),
  });

  const up = parentPath(path);
  const visible = (files.data || []).filter((entry) => !entry.hidden);

  return (
    <Page
      title={drive ? drive.label : "Files"}
      titleId="files-title"
    >
      <div className="flex items-center gap-2 font-mono text-xs text-secondary mb-4">
        <Link to={folderHref(id, "")} className="hover:text-accent">
          {drive?.label || "Drive"}
        </Link>
        {path.split("/").filter(Boolean).map((segment, i, all) => (
          <span key={`${segment}-${i}`}>
            <span className="text-accent">/</span>
            <Link
              to={folderHref(id, all.slice(0, i + 1).join("/"))}
              className="hover:text-accent"
            >
              {segment}
            </Link>
          </span>
        ))}
      </div>

      {up !== null && (
        <Button variant="outline" size="sm" className="mb-4" asChild>
          <Link to={folderHref(id, up)}>↑ Up one folder</Link>
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
        <p className="text-secondary text-sm">Drop files here to put them in this folder</p>
        <p className="text-secondary/70 text-xs mt-1">
          Small files save instantly. Big files continue even if the connection blips.
        </p>
        {uploading && (
          <p className="text-secondary text-xs mt-2">
            Saving {uploading.name}… {fmtSize(uploading.received)} of {fmtSize(uploading.size)}
          </p>
        )}
        {uploadError && <p className="text-error text-xs mt-2">{uploadError}</p>}
      </div>

      <div className="grid gap-3">
        {visible.map((entry) => (
          <Card key={entry.name} padding={false} noPopIn noHeightAnim>
            <div className="flex items-center justify-between p-4 gap-2">
              {entry.kind === "dir" ? (
                <Link
                  to={folderHref(id, joinPath(path, entry.name))}
                  className="flex items-center gap-3 text-left flex-1 min-w-0"
                >
                  <Folder size={18} className="text-accent shrink-0" />
                  <span className="text-primary font-mono text-sm truncate">{entry.name}</span>
                </Link>
              ) : (
                <div className="flex items-center gap-3 text-left flex-1 min-w-0">
                  <FileIcon size={18} className="text-accent shrink-0" />
                  <span className="text-primary font-mono text-sm truncate">{entry.name}</span>
                </div>
              )}
              <span className="text-primary text-xs w-20 text-right hidden sm:block">{fmtSize(entry.size)}</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="p-2 text-primary hover:text-accent"
                  aria-label={`Rename ${entry.name}`}
                  onClick={() => { setRenameTarget(entry); setRenameValue(entry.name); }}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="p-2 text-primary hover:text-error"
                  aria-label={`Move ${entry.name} to trash`}
                  onClick={() => setDeleteTarget(entry)}
                >
                  <Trash2 size={14} />
                </button>
                {entry.kind === "file" && (
                  <a
                    className="p-2 text-primary hover:text-accent"
                    href={`/api/v1/drives/${id}/files/content?path=${encodeURIComponent(joinPath(path, entry.name))}&download=1`}
                    aria-label={`Download ${entry.name}`}
                  >
                    <Download size={14} />
                  </a>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      {!files.isLoading && visible.length === 0 && (
        <p className="text-secondary text-sm mt-4">This folder is empty. Drop files above.</p>
      )}

      {deleteTarget && (
        <ModalCard title="Move to trash?" onClose={() => setDeleteTarget(null)}>
          <p className="text-primary text-sm">
            <span className="font-mono">{deleteTarget.name}</span> will move to
            Luna&apos;s trash on this drive. You can get it back later.
          </p>
          <div className="mt-4 flex gap-3">
            <Button variant="danger" loading={removeMutation.isPending} onClick={() => removeMutation.mutate(deleteTarget)}>
              Move to trash
            </Button>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Keep it</Button>
          </div>
        </ModalCard>
      )}

      {renameTarget && (
        <ModalCard title={`Rename ${renameTarget.name}`} onClose={() => setRenameTarget(null)}>
          <input
            className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            value={renameValue}
            maxLength={255}
            onChange={(e) => setRenameValue(e.target.value)}
          />
          {uploadError && <p className="text-error text-xs mt-2">{uploadError}</p>}
          <div className="mt-4 flex gap-3">
            <Button
              variant="secondary"
              loading={renameMutation.isPending}
              onClick={() => renameMutation.mutate({ entry: renameTarget, newName: renameValue })}
            >
              Rename
            </Button>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
          </div>
        </ModalCard>
      )}
    </Page>
  );
}
