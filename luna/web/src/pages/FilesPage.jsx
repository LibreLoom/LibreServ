import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Copy,
  Download,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderInput,
  Pencil,
  RotateCcw,
  Trash2,
  UploadCloud,
} from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import Button from "../components/ui/Button";
import TextLink from "../components/ui/TextLink";
import Dropdown from "../components/common/Dropdown";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";
import HouseholdSearch from "../components/files/HouseholdSearch";
import ComputerMountHelp from "../components/files/ComputerMountHelp";
import CreateShareModal from "../components/files/CreateShareModal";
import { getDrives, getJson, postJson } from "../lib/api";
import { useAuth } from "../context/AuthContext";

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

function jobBusy(job) {
  return job.state === "running" || job.state === "queued";
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
  const path = searchParams.get("path") || "";
  const inTrash = searchParams.get("view") === "trash";
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [copyTarget, setCopyTarget] = useState(null);
  const [copyKind, setCopyKind] = useState("copy");
  const [copyDrive, setCopyDrive] = useState("");
  const [copyFolder, setCopyFolder] = useState("");
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [restoreName, setRestoreName] = useState("");
  const [purgeTarget, setPurgeTarget] = useState(null);
  const [sharing, setSharing] = useState(false);
  const filePicker = useRef(null);
  const { user } = useAuth();

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const drive = (drives.data || []).find((d) => d.id === id);

  const files = useQuery({
    queryKey: ["files", id, path],
    queryFn: () => getJson(`/api/v1/drives/${id}/files?path=${encodeURIComponent(path)}`),
    enabled: !!drive && !inTrash,
  });

  const trash = useQuery({
    queryKey: ["trash", id],
    queryFn: () => getJson(`/api/v1/drives/${id}/trash`),
    enabled: !!drive && inTrash,
  });

  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => getJson("/api/v1/jobs"),
    refetchInterval: (q) => ((q.state.data || []).some(jobBusy) ? 1000 : false),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["files", id, path] });
    queryClient.invalidateQueries({ queryKey: ["trash", id] });
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

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
      const raw = err instanceof Error ? err.message : String(err);
      setUploadError(raw.replace(/^Error:\s*/i, ""));
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

  const copyMutation = useMutation({
    mutationFn: async () => {
      const fromPath = joinPath(path, copyTarget.name);
      return postJson("/api/v1/jobs", {
        kind: copyKind,
        from_drive: id,
        from_path: fromPath,
        to_drive: copyDrive || id,
        to_path: copyFolder,
      });
    },
    onSuccess: () => { setCopyTarget(null); invalidate(); },
    onError: (err) => setUploadError(String(err)),
  });

  const restoreMutation = useMutation({
    mutationFn: (/** @type {any} */ item) =>
      postJson(`/api/v1/drives/${id}/files/restore`, {
        path: item.path,
        dest: restoreName,
      }),
    onSuccess: () => { setRestoreTarget(null); invalidate(); },
    onError: (err) => setUploadError(String(err)),
  });

  const purgeMutation = useMutation({
    mutationFn: (/** @type {any} */ item) =>
      postJson(`/api/v1/drives/${id}/files/purge`, { path: item.path }),
    onSuccess: () => { setPurgeTarget(null); invalidate(); },
    onError: (err) => setUploadError(String(err)),
  });

  const cancelMutation = useMutation({
    mutationFn: async (jobId) => {
      const res = await fetch(`/api/v1/jobs/${jobId}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error(await parseError(res));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const up = parentPath(path);
  const visible = (files.data || []).filter((entry) => !entry.hidden);
  const activeJobs = (jobs.data || []).filter(jobBusy);
  const trashItems = trash.data || [];

  return (
    <Page
      title={inTrash ? "Trash" : (drive ? drive.label : "Files")}
      titleId="files-title"
    >
      <HouseholdSearch compact />

      {activeJobs.length > 0 && (
        <div className="grid gap-3 mb-4">
          {activeJobs.map((job) => (
            <Card key={job.id} padding>
              <p className="text-primary text-sm font-mono">
                {job.kind === "move" ? "Moving" : "Copying"} {job.from_path || "a file"}
              </p>
              <p className="text-primary text-xs mt-1">
                {job.total > 0
                  ? `${Math.min(100, Math.round((100 * job.progress) / job.total))}% done`
                  : "Starting…"}
              </p>
              <div className="mt-2 h-2 rounded-pill bg-primary overflow-hidden" aria-hidden="true">
                <div
                  className="h-full bg-accent motion-safe:transition-all"
                  style={{ width: `${job.total > 0 ? Math.min(100, (100 * job.progress) / job.total) : 8}%` }}
                />
              </div>
              <div className="mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  loading={cancelMutation.isPending}
                  onClick={() => cancelMutation.mutate(job.id)}
                >
                  Cancel
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="mb-4" padding>
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-primary">
          <TextLink to={folderHref(id, "")} surface="secondary">
            {drive?.label || "Drive"}
          </TextLink>
          {inTrash ? (
            <span className="flex items-center gap-2">
              <span className="text-accent">/</span>
              <span>Trash</span>
            </span>
          ) : (
            path.split("/").filter(Boolean).map((segment, i, all) => (
              <span key={`${segment}-${i}`} className="flex items-center gap-2">
                <span className="text-accent">/</span>
                <TextLink to={folderHref(id, all.slice(0, i + 1).join("/"))} surface="secondary">
                  {segment}
                </TextLink>
              </span>
            ))
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {!inTrash && up !== null && (
            <Button variant="outline" surface="secondary" size="sm" asChild>
              <Link to={folderHref(id, up)}>↑ Up one folder</Link>
            </Button>
          )}
          {inTrash ? (
            <Button variant="outline" surface="secondary" size="sm" asChild>
              <Link to={`/drives/${id}`}>Back to files</Link>
            </Button>
          ) : (
            <>
              <Button variant="outline" surface="secondary" size="sm" asChild>
                <Link to={`/drives/${id}?view=trash`}>Open trash</Link>
              </Button>
              <Button variant="outline" surface="secondary" size="sm" onClick={() => setSharing(true)}>
                Share this folder
              </Button>
            </>
          )}
        </div>
      </Card>

      {!inTrash && (
        <Card
          className={`mb-6 text-center border-2 border-dashed ${dragOver ? "border-accent ring-2 ring-accent" : "border-primary/30"}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <UploadCloud size={20} className="text-accent mx-auto mb-2" aria-hidden="true" />
          <p className="text-primary text-sm">Drop files here to put them in this folder</p>
          <p className="text-accent text-xs mt-1">
            Small files save instantly. Big files continue even if the connection blips.
          </p>
          <div className="mt-4">
            <input
              ref={filePicker}
              type="file"
              multiple
              className="sr-only"
              onChange={async (e) => {
                const files = [...(e.target.files || [])];
                e.target.value = "";
                for (const file of files) {
                  await uploadOne(file);
                }
              }}
            />
            <Button
              variant="primary"
              type="button"
              onClick={() => filePicker.current?.click()}
            >
              Choose files
            </Button>
          </div>
          {uploading && (
            <p className="text-primary text-xs mt-2">
              Saving {uploading.name}… {fmtSize(uploading.received)} of {fmtSize(uploading.size)}
            </p>
          )}
          {uploadError && <p className="text-error text-xs mt-2">{uploadError}</p>}
        </Card>
      )}

      {inTrash && uploadError && <PageNotice variant="error" className="mb-4">{uploadError}</PageNotice>}

      {!inTrash && (
        <div className="grid gap-3">
          {visible.map((entry) => (
            <Card key={entry.name} padding={false} noPopIn noHeightAnim>
              <div className="flex items-center justify-between p-4 gap-2">
                {entry.kind === "dir" ? (
                  <Link
                    to={folderHref(id, joinPath(path, entry.name))}
                    className="flex items-center gap-3 text-left flex-1 min-w-0 text-primary hover:text-accent motion-safe:transition-colors"
                  >
                    <Folder size={18} className="text-accent shrink-0" />
                    <span className="font-mono text-sm truncate">{entry.name}</span>
                  </Link>
                ) : (
                  <div className="flex items-center gap-3 text-left flex-1 min-w-0">
                    <FileIcon size={18} className="text-accent shrink-0" />
                    <span className="text-primary font-mono text-sm truncate">{entry.name}</span>
                  </div>
                )}
                <span className="text-primary text-xs w-20 text-right hidden sm:block">{fmtSize(entry.size)}</span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    surface="secondary"
                    size="iconSm"
                    aria-label={`Copy ${entry.name}`}
                    onClick={() => {
                      setCopyKind("copy");
                      setCopyTarget(entry);
                      setCopyDrive(id);
                      setCopyFolder(path);
                    }}
                  >
                    <Copy size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    surface="secondary"
                    size="iconSm"
                    aria-label={`Move ${entry.name}`}
                    onClick={() => {
                      setCopyKind("move");
                      setCopyTarget(entry);
                      setCopyDrive(id);
                      setCopyFolder(path);
                    }}
                  >
                    <FolderInput size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    surface="secondary"
                    size="iconSm"
                    aria-label={`Rename ${entry.name}`}
                    onClick={() => { setRenameTarget(entry); setRenameValue(entry.name); }}
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    surface="secondary"
                    size="iconSm"
                    aria-label={`Move ${entry.name} to trash`}
                    onClick={() => setDeleteTarget(entry)}
                  >
                    <Trash2 size={14} />
                  </Button>
                  {entry.kind === "file" && (
                    <Button
                      variant="ghost"
                      surface="secondary"
                      size="iconSm"
                      asChild
                      aria-label={`Download ${entry.name}`}
                    >
                      <a href={`/api/v1/drives/${id}/files/content?path=${encodeURIComponent(joinPath(path, entry.name))}&download=1`}>
                        <Download size={14} />
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {inTrash && (
        <div className="grid gap-3">
          {trashItems.map((item) => (
            <Card key={item.path} padding={false} noPopIn noHeightAnim>
              <div className="flex items-center justify-between p-4 gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  {item.kind === "dir" ? (
                    <Folder size={18} className="text-accent shrink-0" />
                  ) : (
                    <FileIcon size={18} className="text-accent shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-primary font-mono text-sm truncate">{item.original_name || item.name}</p>
                    <p className="text-primary text-xs">{fmtSize(item.size)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    surface="secondary"
                    size="iconSm"
                    aria-label={`Put ${item.original_name} back`}
                    onClick={() => {
                      setRestoreTarget(item);
                      setRestoreName(item.original_name || item.name);
                    }}
                  >
                    <RotateCcw size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    surface="secondary"
                    size="iconSm"
                    aria-label={`Delete ${item.original_name} forever`}
                    onClick={() => setPurgeTarget(item)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {!inTrash && !files.isLoading && visible.length === 0 && (
        <EmptyState
          className="mt-4"
          icon={FolderOpen}
          title="This folder is empty"
          description="Drop files in the upload area above."
        />
      )}

      {inTrash && !trash.isLoading && trashItems.length === 0 && (
        <EmptyState
          className="mt-4"
          icon={Trash2}
          title="Trash is empty"
          description="When you remove a file, Luna keeps it here so you can put it back."
        />
      )}

      {!inTrash && user?.role === "admin" && drive && (
        <div className="mt-6">
          <ComputerMountHelp driveId={id} driveLabel={drive.label} />
        </div>
      )}

      {deleteTarget && (
        <ModalCard title="Move to trash?" onClose={() => setDeleteTarget(null)}>
          <p className="text-primary text-sm">
            <span className="font-mono">{deleteTarget.name}</span> will move to
            Luna&apos;s trash on this drive. You can get it back later from Open trash.
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
          {uploadError && <PageNotice variant="error" className="mt-2">{uploadError}</PageNotice>}
          <div className="mt-4 flex gap-3">
            <Button
              variant="primary"
              loading={renameMutation.isPending}
              onClick={() => renameMutation.mutate({ entry: renameTarget, newName: renameValue })}
            >
              Rename
            </Button>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
          </div>
        </ModalCard>
      )}

      {copyTarget && (
        <ModalCard
          title={copyKind === "move" ? `Move ${copyTarget.name}` : `Copy ${copyTarget.name}`}
          onClose={() => setCopyTarget(null)}
        >
          <p className="text-primary text-sm mb-3">
            {copyKind === "move"
              ? "Luna will copy it first, then put the original in trash."
              : "The original stays where it is."}
          </p>
          <label className="block text-primary text-xs mb-1">Which drive?</label>
          <Dropdown
            options={(drives.data || []).map((d) => ({ value: d.id, label: d.label }))}
            value={copyDrive}
            onChange={setCopyDrive}
            fullWidth
          />
          <label className="block text-primary text-xs mt-3 mb-1">Folder on that drive</label>
          <input
            className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            value={copyFolder}
            placeholder="Leave blank for the top of the drive"
            onChange={(e) => setCopyFolder(e.target.value)}
          />
          {uploadError && <PageNotice variant="error" className="mt-2">{uploadError}</PageNotice>}
          <div className="mt-4 flex gap-3">
            <Button variant="primary" loading={copyMutation.isPending} onClick={() => copyMutation.mutate()}>
              {copyKind === "move" ? "Start moving" : "Start copying"}
            </Button>
            <Button variant="outline" onClick={() => setCopyTarget(null)}>Cancel</Button>
          </div>
        </ModalCard>
      )}

      {restoreTarget && (
        <ModalCard title="Put this back?" onClose={() => setRestoreTarget(null)}>
          <p className="text-primary text-sm">
            Luna will move it out of trash on this same drive. Choose the name it should have.
          </p>
          <input
            className="mt-3 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            value={restoreName}
            onChange={(e) => setRestoreName(e.target.value)}
            aria-label="Restored file name"
          />
          {uploadError && <PageNotice variant="error" className="mt-2">{uploadError}</PageNotice>}
          <div className="mt-4 flex gap-3">
            <Button variant="primary" loading={restoreMutation.isPending} onClick={() => restoreMutation.mutate(restoreTarget)}>
              Put it back
            </Button>
            <Button variant="outline" onClick={() => setRestoreTarget(null)}>Not now</Button>
          </div>
        </ModalCard>
      )}

      {purgeTarget && (
        <ModalCard title="Delete forever?" onClose={() => setPurgeTarget(null)}>
          <p className="text-primary text-sm">
            <span className="font-mono">{purgeTarget.original_name}</span> will be
            removed for good. Luna cannot get it back after this.
          </p>
          {uploadError && <PageNotice variant="error" className="mt-2">{uploadError}</PageNotice>}
          <div className="mt-4 flex gap-3">
            <Button variant="danger" loading={purgeMutation.isPending} onClick={() => purgeMutation.mutate(purgeTarget)}>
              Delete forever
            </Button>
            <Button variant="outline" onClick={() => setPurgeTarget(null)}>Keep in trash</Button>
          </div>
        </ModalCard>
      )}
      {sharing && (
        <CreateShareModal
          drives={drives.data || []}
          initialDriveId={id}
          initialPath={path}
          onClose={() => setSharing(false)}
          onError={(msg) => setUploadError(msg)}
          onDone={() => setSharing(false)}
        />
      )}
    </Page>
  );
}
