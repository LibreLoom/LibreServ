import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Download, File as FileIcon, Folder, Lock, UploadCloud, X } from "lucide-react";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import ShakeTarget from "../components/ui/ShakeTarget";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";
import { cn } from "@/lib/utils";
import { apiErrorMessage, deleteJson, postJson, putBinaryProgress } from "../lib/api";
import { filesFromDataTransfer } from "../lib/collectUploadFiles";
import { haptic } from "../utils/haptics.js";

const CHUNK_SIZE = 8 * 1024 * 1024;
const UPLOAD_PARALLEL = 2;

function joinRel(base, name) {
  return base ? `${base}/${name}` : name;
}

function parentRel(path) {
  if (!path) return "";
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

function isAbortError(err) {
  return err?.name === "AbortError" || err?.code === 20;
}

async function mapPool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export default function PublicSharePage() {
  const { token } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const rel = searchParams.get("path") || "";
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const [submittedPassword, setSubmittedPassword] = useState("");
  const [error, setError] = useState("");
  const [listing, setListing] = useState(null);
  const [fileMeta, setFileMeta] = useState(null);
  const [uploadOnly, setUploadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploads, setUploads] = useState(/** @type {any[]} */ ([]));
  const [uploadError, setUploadError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const uploadsRef = useRef(/** @type {any[]} */ ([]));
  const fileInputRef = useRef(null);
  const replaceInputRef = useRef(null);

  function authHeaders(extra = {}) {
    const headers = { ...extra };
    if (submittedPassword) headers["X-Share-Password"] = submittedPassword;
    return headers;
  }

  const downloadHref = (childRel, asDownload) => {
    const params = new URLSearchParams();
    if (childRel) params.set("path", childRel);
    if (asDownload) params.set("download", "1");
    const q = params.toString();
    return `/s/${token}${q ? `?${q}` : ""}`;
  };

  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      setError("");
      setFileMeta(null);
      setUploadOnly(false);
      try {
        const params = new URLSearchParams();
        if (rel) params.set("path", rel);
        params.set("meta", "1");
        const q = params.toString();
        const res = await fetch(`/s/${token}${q ? `?${q}` : ""}`, {
          headers: { Accept: "application/json", ...authHeaders() },
        });
        const type = res.headers.get("content-type") || "";
        if (res.status === 401) {
          if (alive) {
            setNeedPassword(true);
            setListing(null);
            setError(submittedPassword ? "That password is wrong. Try again." : "This link needs its password.");
          }
          return;
        }
        if (res.status === 410) {
          if (alive) {
            setListing(null);
            setError("This link has expired. Ask the person who sent it to make a new one.");
          }
          return;
        }
        if (res.status === 404) {
          if (alive) {
            setListing(null);
            setError("This link doesn't exist, or the files aren't on Luna right now.");
          }
          return;
        }
        if (!res.ok) {
          const data = type.includes("json") ? await res.json().catch(() => ({})) : {};
          if (alive) setError(data.error || "Luna couldn't open this link.");
          return;
        }
        if (type.includes("json")) {
          const data = await res.json();
          if (alive) {
            setNeedPassword(false);
            if (data.kind === "upload") {
              setUploadOnly(true);
              setListing(null);
            } else if (data.kind === "file") {
              setFileMeta(data);
              setListing(null);
            } else {
              setListing(data);
            }
          }
        } else if (alive) {
          setNeedPassword(false);
          setFileMeta({ name: "download" });
          setListing(null);
        }
      } catch {
        if (alive) setError("Couldn't reach Luna. For access from anywhere, turn on Luna Connect in Settings → External Services. Otherwise check you're on the same network as Luna.");
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, rel, submittedPassword, reloadKey]);

  function openRel(next) {
    const nextParams = new URLSearchParams(searchParams);
    if (next) nextParams.set("path", next);
    else nextParams.delete("path");
    setSearchParams(nextParams);
  }

  function patchUpload(id, patch) {
    uploadsRef.current = uploadsRef.current.map((row) => (row.id === id ? { ...row, ...patch } : row));
    setUploads([...uploadsRef.current]);
  }

  function removeUpload(id) {
    uploadsRef.current = uploadsRef.current.filter((row) => row.id !== id);
    setUploads([...uploadsRef.current]);
  }

  /**
   * @param {{ id: string, name: string, uploadName: string, size: number, abort: AbortController, file: File }} item
   */
  async function uploadOne(item) {
    const destPath = uploadOnly ? undefined : rel || undefined;
    const session = await postJson(
      `/s/${token}/upload`,
      {
        name: item.uploadName,
        size: item.size,
        ...(destPath ? { path: destPath } : {}),
      },
      { headers: authHeaders(), signal: item.abort.signal },
    );
    patchUpload(item.id, { uploadId: session.upload_id });
    for (let start = 0; start < item.size; start += CHUNK_SIZE) {
      if (item.abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const end = Math.min(start + CHUNK_SIZE, item.size) - 1;
      const chunk = item.file.slice(start, end + 1);
      const progress = await putBinaryProgress(
        `/s/${token}/upload/${session.upload_id}`,
        chunk,
        {
          signal: item.abort.signal,
          headers: authHeaders({ "Content-Range": `bytes ${start}-${end}/${item.size}` }),
          onProgress: (loaded) => {
            patchUpload(item.id, { received: Math.min(item.size, start + loaded) });
          },
        },
      );
      patchUpload(item.id, { received: Number(progress.received) || end + 1 });
    }
    const overwrite = fileMeta ? "1" : undefined;
    await postJson(
      `/s/${token}/upload/${session.upload_id}/complete${overwrite ? `?overwrite=${overwrite}` : ""}`,
      {},
      { headers: authHeaders(), signal: item.abort.signal },
    );
  }

  async function addFiles(fileList) {
    const allFiles = Array.from(fileList || []);
    const files = allFiles.filter((f) => f.size > 0);
    const skipped = allFiles.length - files.length;
    setUploadError("");
    if (!files.length) {
      if (skipped) setUploadError("Luna can't add empty files.");
      return;
    }
    if (skipped > 0) {
      setUploadError(`Skipped ${skipped} empty file${skipped === 1 ? "" : "s"} — Luna can't add empty files.`);
    }
    const batch = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      uploadName: fileMeta ? fileMeta.name || file.name : file.name,
      received: 0,
      size: file.size,
      uploadId: null,
      abort: new AbortController(),
      file,
    }));
    uploadsRef.current = [...uploadsRef.current, ...batch];
    setUploads([...uploadsRef.current]);

    let hadError = false;
    let succeeded = false;
    await mapPool(batch, UPLOAD_PARALLEL, async (item) => {
      try {
        await uploadOne(item);
        removeUpload(item.id);
        succeeded = true;
      } catch (err) {
        removeUpload(item.id);
        if (isAbortError(err) || item.abort.signal.aborted) return;
        if (!hadError) {
          hadError = true;
          setUploadError(apiErrorMessage(err, "Couldn't upload that file. Try again."));
        }
      }
    });
    // A read-write folder link should show what just landed without a full
    // page refresh. Upload-only drop boxes deliberately can't see anything,
    // and a replaced file link keeps its name, so only folders reload.
    if (succeeded && listing && listing.permission === "write") {
      setReloadKey((k) => k + 1);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (replaceInputRef.current) replaceInputRef.current.value = "";
  }

  function cancelUpload(id) {
    const row = uploadsRef.current.find((r) => r.id === id);
    if (!row) return;
    row.abort.abort();
    if (row.uploadId) {
      void deleteJson(`/s/${token}/upload/${row.uploadId}`, { headers: authHeaders() }).catch(() => {});
    }
    removeUpload(id);
  }

  const canSeeFiles = listing != null;
  const showUploadZone = uploadOnly || (listing && listing.permission === "write");

  return (
    <div className="min-h-screen bg-primary text-secondary px-4 py-12 flex flex-col items-center">
      <div className="w-full max-w-lg">
        <h1 className="font-mono text-2xl text-center mb-6">
          {uploadOnly ? "Add files" : "Shared with you"}
        </h1>
        {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}
        {uploadError && <PageNotice variant="error" className="mb-4">{uploadError}</PageNotice>}

        {needPassword && (
          <Card icon={Lock} title="This link is locked">
            <p className="text-primary text-sm">
              The person who sent this chose a password. Type it to open the link.
            </p>
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setSubmittedPassword(password);
              }}
            >
              <ShakeTarget shake={error}>
                <input
                  type="password"
                  className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
                  placeholder="Password for this link"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                />
              </ShakeTarget>
              <Button type="submit" variant="primary" fullWidth>Open</Button>
            </form>
          </Card>
        )}

        {loading && !needPassword && (
          <Card>
            <p className="text-primary text-sm">Opening the shared files…</p>
          </Card>
        )}

        {fileMeta && !loading && (
          <Card icon={FileIcon} title="A file was shared with you">
            <p className="text-primary text-sm">Tap download to save it on this device.</p>
            <div className="mt-4 flex gap-3">
              <Button variant="primary" asChild>
                <a href={downloadHref(rel, true)}>
                  <Download size={16} /> Download
                </a>
              </Button>
              {fileMeta.permission === "write" && (
                <Button variant="outline" onClick={() => replaceInputRef.current?.click()}>
                  <UploadCloud size={16} /> Replace file
                </Button>
              )}
            </div>
            <input
              ref={replaceInputRef}
              type="file"
              className="hidden"
              aria-label="Replace this file"
              onChange={(e) => addFiles(e.target.files)}
            />
          </Card>
        )}

        {uploadOnly && !loading && (
          <Card icon={UploadCloud} title="Add files to this folder">
            <p className="text-primary text-sm">
              Drop files here. People with this link can add files, but can't see what's already in the folder.
            </p>
            <label
              className={cn(
                "mt-4 flex flex-col items-center justify-center gap-2 rounded-large-element border-2 border-dashed p-8 cursor-pointer motion-safe:transition-colors motion-safe:duration-150",
                dragOver
                  ? "border-accent bg-accent/20 text-secondary"
                  : "border-secondary/30 bg-primary text-secondary hover:border-accent",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={async (e) => {
                e.preventDefault();
                setDragOver(false);
                const files = await filesFromDataTransfer(e.dataTransfer);
                addFiles(files);
              }}
            >
              <UploadCloud size={22} className="text-accent" />
              <span className="text-sm">Choose files or drop them here</span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                aria-label="Add files"
                onChange={(e) => addFiles(e.target.files)}
              />
            </label>
          </Card>
        )}

        {listing && (
          <div className="space-y-3">
            {listing.permission === "write" && (
              <Card padding={false} noPopIn noHeightAnim>
                <label
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-large-element border-2 border-dashed p-4 cursor-pointer motion-safe:transition-colors motion-safe:duration-150",
                    dragOver
                      ? "border-accent bg-accent/20 text-primary"
                      : "border-secondary/30 bg-secondary text-primary hover:border-accent",
                  )}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={async (e) => {
                    e.preventDefault();
                    setDragOver(false);
                    haptic("heavy");
                    const files = await filesFromDataTransfer(e.dataTransfer);
                    addFiles(files);
                  }}
                >
                  <UploadCloud size={18} className="text-accent" />
                  <span className="text-sm">Add files to this folder</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    aria-label="Add files"
                    onChange={(e) => addFiles(e.target.files)}
                  />
                </label>
              </Card>
            )}
            {rel && (
              <Button
                variant="outline"
                surface="primary"
                size="sm"
                onClick={() => {
                  haptic("medium");
                  openRel(parentRel(rel));
                }}
              >
                ↑ Up one folder
              </Button>
            )}
            {(listing.entries || []).map((entry) => (
              <Card key={entry.name} padding={false} noPopIn noHeightAnim>
                <div className="flex items-center justify-between p-4 gap-2">
                  {entry.kind === "dir" ? (
                    <button
                      type="button"
                      className="flex items-center gap-3 text-left flex-1 min-w-0 text-primary"
                      onClick={() => {
                        haptic("medium");
                        openRel(joinRel(rel, entry.name));
                      }}
                    >
                      <Folder size={18} className="text-accent shrink-0" />
                      <span className="font-mono text-sm truncate">{entry.name}</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <FileIcon size={18} className="text-accent shrink-0" />
                      <span className="text-primary font-mono text-sm truncate">{entry.name}</span>
                    </div>
                  )}
                  {entry.kind !== "dir" && (
                    <Button size="sm" variant="outline" asChild>
                      <a href={downloadHref(joinRel(rel, entry.name), true)}>Download</a>
                    </Button>
                  )}
                </div>
              </Card>
            ))}
            {!loading && canSeeFiles && (listing.entries || []).length === 0 && (
              <EmptyState
                icon={Folder}
                title="This folder is empty"
                description="There's nothing here to download."
              />
            )}
          </div>
        )}

        {showUploadZone && uploads.length > 0 && (
          <div className="mt-4 space-y-2">
            {uploads.map((item) => (
              <Card key={item.id} padding={false} noPopIn noHeightAnim>
                <div className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-primary font-mono text-sm truncate">{item.name}</p>
                    <div className="mt-1 h-1.5 rounded-pill bg-primary overflow-hidden">
                      <div
                        className="h-full rounded-pill bg-accent motion-safe:transition-all motion-safe:duration-200"
                        style={{ width: `${item.size ? Math.min(100, Math.round((item.received / item.size) * 100)) : 0}%` }}
                      />
                    </div>
                    <p className="text-primary text-xs mt-1">
                      {fmtSize(item.received)} of {fmtSize(item.size)}
                    </p>
                  </div>
                  <Button size="iconSm" variant="ghost" aria-label={`Cancel ${item.name}`} onClick={() => cancelUpload(item.id)}>
                    <X size={14} />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
