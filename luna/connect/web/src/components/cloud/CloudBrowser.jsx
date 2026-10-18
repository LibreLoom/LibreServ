import { useEffect, useId, useState } from "react";
import { Button } from "../ui/button.jsx";
import { Label } from "../ui/label.jsx";
import { groupByStarter, loadTree } from "../../lib/cloudUnlock.js";
import { downloadFile, downloadFolder } from "../../lib/cloudDownload.js";
import { baseName, filesUnder, formatSize, formatWhen, listFolder, versionLabel } from "../../lib/cloudTree.js";
import { PrivateItemsRow } from "./PrivateItemsRow.jsx";

const SELECT_CLASS =
  "flex h-10 w-full max-w-xs rounded-pill border border-input bg-background px-4 py-2 font-mono text-sm text-foreground outline-none transition-colors focus-visible:border-ring";
const ROW_CLASS = "rounded-large-element border border-border px-4 py-3 flex flex-wrap items-center justify-between gap-3";

/**
 * Backups grouped by who started them, with a version picker and downloads.
 * @param {{ source: import("../../lib/cloudSource.js").CloudSource,
 *   backups: import("../../lib/cloudUnlock.js").CloudBackup[],
 *   privateOwners?: string[],
 *   groupActions?: (group: { startedBy: string, name: string, backups: import("../../lib/cloudUnlock.js").CloudBackup[] }) => import("react").ReactNode,
 *   backupActions?: (backup: import("../../lib/cloudUnlock.js").CloudBackup) => import("react").ReactNode }} props
 */
export function CloudBrowser({ source, backups, privateOwners = [], groupActions, backupActions }) {
  const versionId = useId();
  const [selectedId, setSelectedId] = useState(/** @type {string | null} */ (null));
  const [versionIdx, setVersionIdx] = useState(0);
  const [folder, setFolder] = useState("");
  const [tree, setTree] = useState({ key: "", entries: /** @type {any[] | null} */ (null), error: "" });
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  const selected = backups.find((b) => b.protectionId === selectedId) || null;
  const version = selected ? selected.versions[versionIdx] : null;
  const treeKey = selected && version ? `${selected.protectionId}:${version.snapshotId}` : "";

  useEffect(() => {
    if (!selected || !version) return undefined;
    let cancelled = false;
    loadTree(source, selected, version).then(
      (entries) => {
        if (!cancelled) setTree({ key: treeKey, entries, error: "" });
      },
      (err) => {
        if (!cancelled) setTree({ key: treeKey, entries: null, error: err.message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selected, version, source, treeKey]);

  function openBackup(protectionId) {
    setSelectedId(protectionId);
    setVersionIdx(0);
    setFolder("");
    setDownloadError("");
  }

  function closeBackup() {
    setSelectedId(null);
    setFolder("");
    setDownloadError("");
  }

  function changeVersion(index) {
    setVersionIdx(index);
    setFolder("");
    setDownloadError("");
  }

  async function run(task) {
    setDownloading(true);
    setDownloadError("");
    try {
      await task();
    } catch (err) {
      setDownloadError(err.message);
    } finally {
      setDownloading(false);
    }
  }

  if (!selected) {
    const groups = groupByStarter(backups, privateOwners);
    if (groups.length === 0) {
      return <p className="text-sm text-muted-foreground">No backups here yet.</p>;
    }
    return (
      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.startedBy} className="space-y-3" aria-label={group.name}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-mono text-lg">{group.name}</h3>
              {groupActions?.(group)}
            </div>
            {group.backups
              .filter((backup) => !backup.private)
              .map((backup) => {
              const count = backup.versions.length;
              return (
                <div key={backup.protectionId} className={ROW_CLASS}>
                  <div className="min-w-0">
                    <p className="text-sm">{backup.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {count === 1 ? "1 version" : `${count} versions`} · Latest {formatWhen(backup.versions[0].createdAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => openBackup(backup.protectionId)}>
                      Open
                    </Button>
                    {backupActions?.(backup)}
                  </div>
                </div>
              );
            })}
            {group.privateRow ? (
              <PrivateItemsRow
                kind={group.privateRow}
                backups={group.backups.filter((backup) => backup.private)}
                onOpen={openBackup}
              />
            ) : null}
          </section>
        ))}
      </div>
    );
  }

  const loading = tree.key !== treeKey;
  const entries = !loading && !tree.error ? tree.entries : null;
  const treeError = !loading ? tree.error : "";
  const listing = entries ? listFolder(entries, folder) : null;
  const folderEmpty = entries ? filesUnder(entries, folder).length === 0 : true;
  const segments = folder ? folder.split("/") : [];
  const actionsDisabled = loading || downloading || folderEmpty;

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={closeBackup}>
        Back to all backups
      </Button>
      <h3 className="font-mono text-lg">{selected.name}</h3>

      <div className="space-y-2">
        <Label htmlFor={versionId}>Version</Label>
        <select
          id={versionId}
          aria-label="Version"
          className={SELECT_CLASS}
          value={versionIdx}
          onChange={(e) => changeVersion(Number(e.target.value))}
        >
          {selected.versions.map((v, i) => (
            <option key={v.snapshotId} value={i}>
              {versionLabel(v.createdAt, i)}
            </option>
          ))}
        </select>
      </div>

      <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
        <Button variant="ghost" size="sm" onClick={() => setFolder("")}>
          All files
        </Button>
        {segments.map((segment, i) => {
          const path = segments.slice(0, i + 1).join("/");
          return (
            <span key={path} className="flex items-center gap-1">
              <span aria-hidden="true">/</span>
              <Button variant="ghost" size="sm" onClick={() => setFolder(path)}>
                {segment}
              </Button>
            </span>
          );
        })}
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={actionsDisabled}
          onClick={() => run(() => downloadFolder(source, selected, version, entries, folder))}
        >
          {folder === "" ? "Download everything" : "Download this folder"}
        </Button>
      </div>
      {downloading ? <p role="status" className="text-sm text-muted-foreground">Decrypting and downloading…</p> : null}
      {downloadError ? <p role="alert" className="text-sm text-error">{downloadError}</p> : null}

      {loading && !treeError ? <p className="text-sm text-muted-foreground">Opening this version…</p> : null}
      {treeError ? <p role="alert" className="text-sm text-error">{treeError}</p> : null}

      {listing ? (
        <div className="space-y-2">
          {listing.folders.map((f) => (
            <div key={f.path} className={ROW_CLASS}>
              <Button variant="ghost" size="sm" onClick={() => setFolder(f.path)}>
                {f.name}
              </Button>
              <span className="text-sm text-muted-foreground">
                {f.files === 1 ? "1 file" : `${f.files} files`} · {formatSize(f.size)}
              </span>
            </div>
          ))}
          {listing.files.map((file) => (
            <div key={file.path} className={ROW_CLASS}>
              <div className="min-w-0">
                <p className="text-sm break-all">{baseName(file.path)}</p>
                <p className="text-sm text-muted-foreground">
                  {formatSize(file.size)} · {formatWhen(file.mtime)}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={downloading}
                onClick={() => run(() => downloadFile(source, selected, version, file))}
              >
                Download
              </Button>
            </div>
          ))}
          {listing.folders.length === 0 && listing.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing in this folder.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
