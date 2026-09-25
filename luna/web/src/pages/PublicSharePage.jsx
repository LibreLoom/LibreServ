import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Image as ImageIcon, Lock } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { apiErrorMessage, getJson } from "../lib/api";
import { CAP, hasCap } from "../lib/access.js";
import { FileSourceProvider, shareSource } from "../lib/fileSource.jsx";
import { parentPath, pathBasename } from "../lib/paths.js";
import DriveFileExplorer, { UploadProgressList } from "../components/files/DriveFileExplorer.jsx";
import UploadFilesPanel from "../components/files/UploadFilesPanel.jsx";
import useFileNavigation from "../hooks/useFileNavigation.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import FormResponder from "../components/files/forms/FormResponder.jsx";
import PhotoThumb from "../components/gallery/PhotoThumb.jsx";
import PhotoLightbox, {
  resolveDisplaySrc,
  resolveDownloadSrc,
} from "../components/gallery/PhotoLightbox.jsx";
import useMultiSelect, { photoSelectionKey } from "../hooks/useMultiSelect.js";


const UPLOAD_PARALLEL = 2;

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

function isMediaName(name) {
  return /\.(jpe?g|png|gif|webp|avif|heic|heif|mp4|mov|webm|mkv|avi|m4v)$/i.test(name || "");
}

export default function PublicSharePage() {
  const { token } = useParams();
  return <PublicShareSession key={token} />;
}

function PublicShareSession() {
  const { token } = useParams();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const [submittedPassword, setSubmittedPassword] = useState("");
  const [error, setError] = useState("");
  /** The link's meta payload: { kind, name?, size?, item_count?, caps }. */
  const [meta, setMeta] = useState(null);
  /** Resolved `kind: "form"` payload — a respond link mounts the responder. */
  const [formDoc, setFormDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploads, setUploads] = useState(/** @type {any[]} */ ([]));
  const [uploadError, setUploadError] = useState("");
  const [batchDone, setBatchDone] = useState(false);
  const [lightbox, setLightbox] = useState(/** @type {{ key: string }|null} */ (null));
  const uploadsRef = useRef(/** @type {any[]} */ ([]));
  const [passwordRetry, setPasswordRetry] = useState(0);
  const sentinel = useRef(null);

  function authHeaders(extra = {}) {
    const headers = { ...extra };
    if (submittedPassword) headers["X-Share-Password"] = submittedPassword;
    return headers;
  }

  const kind = meta?.kind || "";
  const caps = meta?.caps || "";
  const canView = hasCap(caps, CAP.VIEW);
  const canUpload = hasCap(caps, CAP.UPLOAD);
  const isDropbox = kind === "dropbox";
  const isFolder = kind === "folder";
  const isFile = kind === "file";
  const isAlbum = kind === "album";

  const {
    path: rel,
    selectPath,
    viewerPath,
    onPathChange: openRel,
    onViewerPathChange: handleViewerPathChange,
    clearSelectParam,
  } = useFileNavigation({ defaultFile: meta?.name || null, singleFile: isFile });

  const source = useMemo(
    () =>
      shareSource({
        token: token || "",
        password: submittedPassword,
        kind: kind || "folder",
        fileName: meta?.name || "",
        caps,
      }),
    [token, submittedPassword, kind, meta?.name, caps],
  );

  // Album items page in separately — they paginate.
  const album = useInfiniteQuery({
    queryKey: ["public-link-items", token],
    initialPageParam: 0,
    enabled: isAlbum && canView && !needPassword,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set("limit", "80");
      params.set("offset", String(pageParam || 0));
      return getJson(`/s/${token}/items?${params}`, { headers: authHeaders() });
    },
    getNextPageParam: (last) =>
      last?.has_more ? (last.next_offset ?? (last.items?.length || 0)) : undefined,
  });
  const albumPages = useMemo(() => album.data?.pages || [], [album.data?.pages]);
  const albumItems = useMemo(() => albumPages.flatMap((p) => p.items || []), [albumPages]);
  const selection = useMultiSelect({ items: albumItems });

  const loadMore = useCallback(() => {
    if (album.hasNextPage && !album.isFetchingNextPage) album.fetchNextPage();
  }, [album]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !album.hasNextPage) return undefined;
    const io = new IntersectionObserver(
      (list) => {
        if (list.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [album.hasNextPage, loadMore, albumItems.length]);

  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      setError("");
      setMeta(null);
      setFormDoc(null);
      try {
        // Meta describes the link, not the folder you're standing in — fetch
        // it once so navigating never remounts the explorer (that remount is
        // what killed the browser's transition animation).
        const params = new URLSearchParams({ meta: "1" });
        const res = await fetch(`/s/${token}?${params}`, {
          headers: { Accept: "application/json", ...authHeaders() },
        });
        const type = res.headers.get("content-type") || "";
        if (res.status === 401) {
          if (alive) {
            setNeedPassword(true);
            setError(submittedPassword ? "That password is wrong. Try again." : "This link needs its password.");
          }
          return;
        }
        if (res.status === 410) {
          if (alive) setError("This link has expired. Ask the person who sent it to make a new one.");
          return;
        }
        if (res.status === 404) {
          if (alive) setError("This link doesn't exist, or the files aren't on Luna right now.");
          return;
        }
        if (!res.ok) {
          const data = type.includes("json") ? await res.json().catch(() => ({})) : {};
          if (alive) setError(data.error || "Luna couldn't open this link.");
          return;
        }
        if (!type.includes("json")) {
          // Non-JSON means the link streamed bytes — treat as a file.
          if (alive) {
            setNeedPassword(false);
            setMeta({ kind: "file", name: "download", caps });
          }
          return;
        }
        const data = await res.json();
        if (!alive) return;
        setNeedPassword(false);
        if (data.kind === "form") {
          setFormDoc(data);
          return;
        }
        setMeta(data);
      } catch {
        if (alive) setError("Could not reach Luna. Check your connection and try again.");
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, submittedPassword, passwordRetry]);

  // URL builders so the real browser's links stay on /s/{token}.
  const shareFolderHref = useCallback(
    (_driveId, folderPath) =>
      `/s/${token}${folderPath ? `?path=${encodeURIComponent(folderPath)}` : ""}`,
    [token],
  );
  const shareFileHref = useCallback(
    (_driveId, filePath) => {
      const dir = parentPath(filePath) ?? "";
      const params = new URLSearchParams();
      if (dir) params.set("path", dir);
      params.set("file", pathBasename(filePath));
      return `/s/${token}?${params}`;
    },
    [token],
  );

  function patchUpload(id, patch) {
    uploadsRef.current = uploadsRef.current.map((row) => (row.id === id ? { ...row, ...patch } : row));
    setUploads([...uploadsRef.current]);
  }

  function removeUpload(id) {
    uploadsRef.current = uploadsRef.current.filter((row) => row.id !== id);
    setUploads([...uploadsRef.current]);
  }

  async function uploadOne(item) {
    await source.uploadFile(token || "", item.file, "", item.uploadName, {
      signal: item.abort.signal,
      onSession: (uploadId) => patchUpload(item.id, { uploadId }),
      onProgress: (received) => patchUpload(item.id, { received }),
    });
  }

  async function addFiles(fileList) {
    const allFiles = Array.from(fileList || []);
    // Album links only take photos and videos — the server enforces it too,
    // but skipping early keeps the error readable.
    const eligible = isAlbum ? allFiles.filter((f) => isMediaName(f.name)) : allFiles;
    const skippedMedia = allFiles.length - eligible.length;
    const files = eligible.filter((f) => f.size > 0);
    const skippedEmpty = eligible.length - files.length;
    setUploadError("");
    setBatchDone(false);
    if (skippedMedia > 0) {
      setUploadError("Only photos and videos can go in this album.");
      return;
    }
    if (!files.length) {
      if (skippedEmpty) setUploadError("Luna can't add empty files.");
      return;
    }
    if (skippedEmpty > 0) {
      setUploadError(`Skipped ${skippedEmpty} empty file${skippedEmpty === 1 ? "" : "s"} — Luna can't add empty files.`);
    }
    const batch = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      uploadName: file.name,
      received: 0,
      size: file.size,
      uploadId: null,
      abort: new AbortController(),
      file,
    }));
    uploadsRef.current = [...uploadsRef.current, ...batch];
    setUploads([...uploadsRef.current]);

    let hadError = false;
    let completed = 0;
    await mapPool(batch, UPLOAD_PARALLEL, async (item) => {
      try {
        await uploadOne(item);
        removeUpload(item.id);
        completed += 1;
      } catch (err) {
        removeUpload(item.id);
        if (isAbortError(err) || item.abort.signal.aborted) return;
        if (!hadError) {
          hadError = true;
          setUploadError(apiErrorMessage(err, "Couldn't upload that file. Try again."));
        }
      }
    });
    if (completed > 0) {
      setBatchDone(true);
      addToast({
        type: "success",
        message: completed === 1 ? "1 file uploaded." : `${completed} files uploaded.`,
      });
      if (isAlbum) {
        queryClient.invalidateQueries({ queryKey: ["public-link-items", token] });
      }
    }
  }

  function cancelUpload(id) {
    const row = uploadsRef.current.find((r) => r.id === id);
    if (!row) return;
    row.abort.abort();
    if (row.uploadId) {
      void source.cancelUpload(token || "", row.uploadId).catch(() => {});
    }
    removeUpload(id);
  }

  function albumContentSrc(photo) {
    return photo?.content || photo?.thumb || "";
  }
  function albumDownloadSrc(photo) {
    return photo?.download || photo?.content || photo?.thumb || "";
  }
  function downloadSelected() {
    for (const photo of selection.selectedItems) {
      const href = albumDownloadSrc(photo);
      if (!href) continue;
      const a = document.createElement("a");
      a.href = href;
      a.download = photo.name || "photo";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  // Respond links take over the whole page — one question per screen.
  if (formDoc && !needPassword) {
    return (
      <div className="flex min-h-screen flex-col bg-primary text-secondary">
        {error && (
          <div className="p-4">
            <PageNotice variant="error">{error}</PageNotice>
          </div>
        )}
        {loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center" role="status">
            <p className="font-mono text-sm uppercase tracking-widest text-secondary">Opening</p>
          </div>
        ) : (
          <FormResponder
            token={token}
            form={formDoc.form && typeof formDoc.form === "object" ? formDoc.form : {}}
            sharePassword={submittedPassword}
          />
        )}
      </div>
    );
  }

  if (isAlbum && !needPassword) {
    const title = meta?.name || "Shared album";
    const lightboxIndex = lightbox
      ? Math.max(0, albumItems.findIndex((p) => photoSelectionKey(p) === lightbox.key))
      : 0;
    const lightboxPhoto = albumItems[lightboxIndex];
    return (
      <div className="min-h-screen bg-primary text-secondary">
        <Page title={title} titleId="public-album-title">
          {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}
          {loading || album.isLoading ? (
            <p className="text-sm">Opening album…</p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">
                  {meta?.item_count ?? albumItems.length} {(meta?.item_count ?? albumItems.length) === 1 ? "item" : "items"}
                  {canUpload ? " · You can add photos and videos" : " · View only"}
                  {album.hasNextPage ? " · More available" : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant={selection.selectMode ? "accent" : "outline"}
                    surface="primary"
                    size="sm"
                    onClick={() => (selection.selectMode ? selection.exit() : selection.enter())}
                  >
                    {selection.selectMode ? "Cancel" : "Select"}
                  </Button>
                  {selection.selectMode && selection.selectedCount > 0 && (
                    <Button
                      type="button"
                      variant="secondary"
                      surface="primary"
                      size="sm"
                      onClick={downloadSelected}
                    >
                      <Download size={16} />
                      Download selected ({selection.selectedCount})
                    </Button>
                  )}
                  <Button variant="secondary" surface="primary" size="sm" asChild>
                    <a href={`/s/${token}/zip`}>
                      <Download size={16} />
                      Download album
                    </a>
                  </Button>
                </div>
              </div>
              {canUpload && (
                <UploadFilesPanel
                  title="Add photos"
                  accept="image/*,video/*"
                  onUploadFiles={addFiles}
                  error={uploadError || null}
                  busy={uploads.length > 0}
                >
                  <UploadProgressList uploads={uploads} onCancel={cancelUpload} />
                </UploadFilesPanel>
              )}
              {albumItems.length === 0 ? (
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
                  {albumItems.map((photo, index) => (
                    <PhotoThumb
                      key={photoSelectionKey(photo) || `${photo.drive_id}/${photo.path}`}
                      photo={photo}
                      index={index}
                      selectMode={selection.selectMode}
                      selected={selection.selected.has(photoSelectionKey(photo))}
                      onToggle={selection.toggle}
                      onLongPress={(p) => {
                        selection.enter();
                        selection.toggle(p);
                      }}
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
              photos={albumItems}
              photoKey={lightbox.key}
              index={lightboxIndex}
              contentSrc={resolveDisplaySrc(lightboxPhoto, {
                contentSrc: albumContentSrc(lightboxPhoto),
              })}
              srcFor={albumContentSrc}
              downloadSrc={resolveDownloadSrc(lightboxPhoto, {
                downloadSrc: albumDownloadSrc(lightboxPhoto),
              })}
              onClose={() => setLightbox(null)}
              onIndexChange={(i) => {
                const next = albumItems[i];
                if (next) setLightbox({ key: photoSelectionKey(next) });
              }}
            />
          )}
        </Page>
      </div>
    );
  }

  // Folders and single files mount the same explorer the signed-in Files
  // page uses — the share source carries the link's caps, so only the
  // permission-scoped affordances differ. Drop boxes get the minimal
  // upload-only surface: no listing, no New, no browsing.
  const driveLike = isFolder || isFile;

  return (
    <div className="min-h-screen bg-primary text-secondary">
      <Page
        title={meta?.name || "Shared with you"}
        titleId="public-share-title"
      >
        {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}
        {uploadError && !isDropbox && <PageNotice variant="error" className="mb-4">{uploadError}</PageNotice>}

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
                setPasswordRetry((n) => n + 1);
              }}
            >
              <ShakeTarget shake={error}>
                <input
                  type="password"
                  className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
                  placeholder="Password for this link"
                  aria-label="Password for this link"
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

        {isDropbox && meta && !needPassword && !loading && (
          <UploadFilesPanel
            onUploadFiles={(files) => addFiles(files)}
            error={uploadError || null}
            busy={uploads.length > 0}
          >
            <UploadProgressList uploads={uploads} onCancel={cancelUpload} />
            {batchDone && uploads.length === 0 && (
              <p className="text-primary text-sm mt-3">Files uploaded.</p>
            )}
          </UploadFilesPanel>
        )}

        {driveLike && meta && !needPassword && !loading && (
          <FileSourceProvider source={source}>
            <DriveFileExplorer
              driveId={token || ""}
              driveLabel={meta.name || "Shared files"}
              drives={[{ id: token || "", label: meta.name || "Shared files" }]}
              path={rel}
              onPathChange={openRel}
              viewerPath={viewerPath}
              onViewerPathChange={handleViewerPathChange}
              selectPath={selectPath || null}
              onSelectPathApplied={clearSelectParam}
              linkNavigation
              folderHref={shareFolderHref}
              fileHref={shareFileHref}
              emptyTitle="This folder is empty"
              emptyDescription={canUpload ? "Add files to get started." : "There's nothing here to download."}
            />
          </FileSourceProvider>
        )}
      </Page>
    </div>
  );
}
