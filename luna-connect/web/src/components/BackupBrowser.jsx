import { useEffect, useMemo, useState } from "react";
import { Download, File as FileIcon, Folder, FolderOpen, X } from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Card } from "./ui/card.jsx";
import { downloadBackup, fetchBackupBlob } from "../api.js";
import { filesInFolder, fmtSize, fmtWhen, listBackupFolder, parentPath } from "../lib/backupTree.js";
import { fileKindLabel, openableKind } from "../lib/fileKinds.js";

const PREVIEW_IMAGE_MAX = 20_000_000;
const PREVIEW_TEXT_MAX = 1_000_000;
const PREVIEW_VIDEO_MAX = 40_000_000;

/**
 * Folder browser for cloud backup copies. Same walk-through as Luna:
 * breadcrumbs, folders, file size/date, open to check, download.
 *
 * @param {{
 *   objects: Array<{ device_id?: string, relative_path?: string, size?: number, updated_at?: number, content_hash?: string }>,
 *   onError?: (message: string) => void,
 * }} props
 */
export function BackupBrowser({ objects = [], onError }) {
  const [path, setPath] = useState("");
  const [openFile, setOpenFile] = useState(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderProgress, setFolderProgress] = useState("");

  const entries = useMemo(() => listBackupFolder(objects, path), [objects, path]);
  const segments = path.split("/").filter(Boolean);
  const up = parentPath(path);
  const folderFiles = useMemo(() => filesInFolder(objects, path, { recursive: true }), [objects, path]);

  function openFolder(next) {
    setPath(next);
    setOpenFile(null);
  }

  async function downloadOne(file) {
    try {
      await downloadBackup(file.device_id, file.relative_path);
    } catch (err) {
      onError?.(err.message);
    }
  }

  async function downloadFolder() {
    if (!folderFiles.length || folderBusy) return;
    setFolderBusy(true);
    try {
      for (let i = 0; i < folderFiles.length; i++) {
        const f = folderFiles[i];
        setFolderProgress(`Downloading ${i + 1} of ${folderFiles.length}`);
        await downloadBackup(f.device_id, f.relative_path);
      }
    } catch (err) {
      onError?.(err.message);
    } finally {
      setFolderBusy(false);
      setFolderProgress("");
    }
  }

  return (
    <div className="space-y-3" data-testid="backup-browser">
      <Card className="p-4 sm:p-5">
        <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-1">
          Current folder
        </p>
        <div className="flex flex-wrap items-center gap-2 font-mono text-sm" aria-live="polite">
          <button
            type="button"
            className="text-foreground hover:underline break-all text-left"
            onClick={() => openFolder("")}
          >
            Cloud backup
          </button>
          {segments.map((segment, i) => {
            const segPath = segments.slice(0, i + 1).join("/");
            return (
              <span key={`${segment}-${i}`} className="flex items-center gap-2 min-w-0">
                <span aria-hidden="true">/</span>
                <button
                  type="button"
                  className="text-foreground hover:underline break-all text-left"
                  onClick={() => openFolder(segPath)}
                >
                  {segment}
                </button>
              </span>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {up !== null && (
            <Button variant="outline" size="sm" type="button" onClick={() => openFolder(up)}>
              ↑ Up one folder
            </Button>
          )}
          {folderFiles.length > 0 && (
            <Button variant="outline" size="sm" type="button" loading={folderBusy} onClick={downloadFolder}>
              {path ? "Download this folder" : "Download all copies"}
            </Button>
          )}
        </div>
        {folderProgress && <p className="mt-2 text-sm font-mono">{folderProgress}</p>}
      </Card>

      <Card className="p-0 overflow-hidden">
        {entries.length === 0 ? (
          <div className="px-6 py-10 text-center space-y-2">
            <FolderOpen className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="font-mono text-sm">Nothing in this folder.</p>
          </div>
        ) : (
          <ul className="m-0 p-0 list-none" aria-label="Files and folders">
            <li className="hidden sm:flex items-center gap-3 px-4 py-2 border-b border-border font-mono text-xs text-muted-foreground">
              <span className="flex-1">Name</span>
              <span className="w-24 text-right">Size</span>
              <span className="w-28 text-right">Updated</span>
              <span className="w-24" aria-hidden="true" />
            </li>
            {entries.map((entry) => {
              const isOpen = openFile && openFile.path === entry.path && openFile.device_id === (entry.device_id || "");
              return (
                <li
                  key={`${entry.kind}:${entry.device_id || ""}:${entry.path}`}
                  className={`flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-b-0 ${
                    isOpen ? "bg-accent/20" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {entry.kind === "dir" ? (
                      <button
                        type="button"
                        className="flex items-center gap-2 min-w-0 text-left hover:underline"
                        onClick={() => openFolder(entry.path)}
                      >
                        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="font-mono text-sm truncate">{entry.name}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="flex items-center gap-2 min-w-0 text-left hover:underline"
                        onClick={() => setOpenFile(entry)}
                      >
                        <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="font-mono text-sm truncate">{entry.name}</span>
                      </button>
                    )}
                  </div>
                  <span className="text-xs w-24 text-right hidden sm:block shrink-0 font-mono">
                    {entry.kind === "dir" && entry.fileCount
                      ? `${entry.fileCount} ${entry.fileCount === 1 ? "file" : "files"}`
                      : fmtSize(entry.size)}
                  </span>
                  <span className="text-xs w-28 text-right hidden sm:block shrink-0 font-mono">
                    {fmtWhen(entry.updated_at)}
                  </span>
                  <div className="shrink-0 w-24 flex justify-end">
                    {entry.kind === "file" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Download ${entry.name}`}
                        onClick={() => downloadOne(entry)}
                      >
                        <Download className="h-4 w-4" />
                        Download
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {openFile && (
        <BackupPreview file={openFile} onClose={() => setOpenFile(null)} onError={onError} onDownload={() => downloadOne(openFile)} />
      )}
    </div>
  );
}

function BackupPreview({ file, onClose, onError, onDownload }) {
  const [preview, setPreview] = useState(null);
  const kind = openableKind(file.name);
  const tooBig =
    (kind === "image" && file.size > PREVIEW_IMAGE_MAX)
    || (kind === "text" && file.size > PREVIEW_TEXT_MAX)
    || (kind === "video" && file.size > PREVIEW_VIDEO_MAX);

  useEffect(() => {
    let cancelled = false;
    let url = "";
    setPreview(null);
    if (!kind || tooBig) return undefined;
    (async () => {
      try {
        const blob = await fetchBackupBlob(file.device_id, file.relative_path);
        if (cancelled) return;
        if (kind === "text") {
          setPreview({ kind, text: await blob.text() });
          return;
        }
        url = URL.createObjectURL(blob);
        setPreview({ kind, url });
      } catch (err) {
        if (!cancelled) onError?.(err.message);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.device_id, file.relative_path, file.name, kind, tooBig, onError]);

  return (
    <Card className="p-4 sm:p-5 space-y-3" data-testid="backup-preview">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm break-all">{file.name}</p>
          <p className="text-sm text-muted-foreground mt-1">
            {fileKindLabel(file.name)}
            {" · "}
            {fmtSize(file.size)}
            {file.updated_at ? ` · ${fmtWhen(file.updated_at)}` : ""}
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label="Close file" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      {tooBig && (
        <p className="text-sm">This file is too large to show here. Download it to open it on your computer.</p>
      )}
      {!kind && !tooBig && (
        <p className="text-sm">We cannot show this file type here. Download it to open it on your computer.</p>
      )}
      {preview?.kind === "image" && preview.url && (
        <img src={preview.url} alt={file.name} className="max-h-80 w-auto max-w-full rounded-large-element border border-border" />
      )}
      {preview?.kind === "video" && preview.url && (
        <video src={preview.url} controls className="max-h-80 w-full rounded-large-element border border-border bg-background">
          Your browser cannot play this video. Download it instead.
        </video>
      )}
      {preview?.kind === "text" && (
        <pre className="max-h-80 overflow-auto rounded-large-element border border-border bg-background text-foreground p-4 text-sm font-mono whitespace-pre-wrap break-words">
          {preview.text}
        </pre>
      )}
      <Button type="button" variant="secondary" size="sm" onClick={onDownload}>
        <Download className="h-4 w-4" />
        Download
      </Button>
    </Card>
  );
}
