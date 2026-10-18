import { useEffect, useId, useState } from "react";
import { ArrowLeft, ChevronRight, Download, File as FileIcon, Folder } from "lucide-react";
import { Button } from "../ui/button.jsx";
import { groupByStarter, loadTree } from "../../lib/cloudUnlock.js";
import { downloadFile, downloadFolder } from "../../lib/cloudDownload.js";
import { baseName, filesUnder, formatSize, formatWhen, listFolder, versionLabel } from "../../lib/cloudTree.js";
import { Chip, ROW_CLASS, RowIcon } from "./Chip.jsx";
import { BackupRow } from "./BackupRow.jsx";
import { PrivateItemsRow } from "./PrivateItemsRow.jsx";

const SELECT_CLASS =
  "h-8 rounded-pill border border-border bg-secondary px-4 font-mono text-sm text-foreground outline-none transition-colors focus-visible:border-ring";

/**
 * Backups grouped by who started them, with a version picker and downloads.
 * @param {{ source: import("../../lib/cloudSource.js").CloudSource,
 *   backups: import("../../lib/cloudUnlock.js").CloudBackup[],
 *   privateOwners?: string[],
 *   showPrivateStatus?: boolean,
 *   privateActions?: (group: { startedBy: string, name: string }) => import("react").ReactNode,
 *   groupActions?: (group: { startedBy: string, name: string, backups: import("../../lib/cloudUnlock.js").CloudBackup[] }) => import("react").ReactNode,
 *   backupActions?: (backup: import("../../lib/cloudUnlock.js").CloudBackup) => import("react").ReactNode }} props
 */
export function CloudBrowser({ source, backups, privateOwners = [], showPrivateStatus = false, privateActions, groupActions, backupActions }) {
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
      <div className="space-y-8">
        {groups.map((group) => (
          <section key={group.startedBy} className="space-y-3" aria-label={group.name}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-mono text-lg">{group.name}</h3>
              {groupActions?.(group)}
            </div>
            {group.backups
              .filter((backup) => !backup.private)
              .map((backup) => (
                <BackupRow
                  key={backup.protectionId}
                  backup={backup}
                  onOpen={openBackup}
                  actions={backupActions?.(backup)}
                />
              ))}
            {group.privateRow || showPrivateStatus ? (
              <PrivateItemsRow
                kind={group.privateRow || "none"}
                backups={group.backups.filter((backup) => backup.private)}
                onOpen={openBackup}
                actions={group.privateRow ? privateActions?.(group) : null}
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
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={closeBackup} className="-ml-3">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to all backups
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-mono text-2xl break-words">{selected.name}</h3>
          <div className="flex items-center gap-2">
            <label htmlFor={versionId} className="text-sm text-muted-foreground">
              Version
            </label>
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
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-large-element bg-secondary px-4 py-3">
        <nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          <Button variant="ghost" size="sm" onClick={() => setFolder("")} aria-current={folder === "" ? "page" : undefined}>
            All files
          </Button>
          {segments.map((segment, i) => {
            const path = segments.slice(0, i + 1).join("/");
            return (
              <span key={path} className="flex items-center gap-1">
                <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <Button variant="ghost" size="sm" onClick={() => setFolder(path)}>
                  {segment}
                </Button>
              </span>
            );
          })}
        </nav>
        <Button
          variant="default"
          size="sm"
          disabled={actionsDisabled}
          onClick={() => run(() => downloadFolder(source, selected, version, entries, folder))}
        >
          <Download className="size-4" aria-hidden="true" />
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
              <button
                type="button"
                onClick={() => setFolder(f.path)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-pill text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open folder ${f.name}`}
              >
                <RowIcon icon={Folder} />
                <span className="min-w-0 space-y-1.5">
                  <span className="block font-mono text-base break-all">{f.name}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Chip>{f.files === 1 ? "1 file" : `${f.files} files`}</Chip>
                    <Chip>{formatSize(f.size)}</Chip>
                  </span>
                </span>
              </button>
              <Button
                variant="outline"
                size="sm"
                disabled={downloading}
                aria-label={`Download folder ${f.name}`}
                onClick={() => run(() => downloadFolder(source, selected, version, entries, f.path))}
              >
                <Download className="size-4" aria-hidden="true" />
                Download
              </Button>
            </div>
          ))}
          {listing.files.map((file) => (
            <div key={file.path} className={ROW_CLASS}>
              <div className="flex min-w-0 items-center gap-3">
                <RowIcon icon={FileIcon} />
                <div className="min-w-0 space-y-1.5">
                  <p className="font-mono text-base break-all">{baseName(file.path)}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Chip>{formatSize(file.size)}</Chip>
                    <Chip>{formatWhen(file.mtime)}</Chip>
                  </div>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={downloading}
                aria-label={`Download ${baseName(file.path)}`}
                onClick={() => run(() => downloadFile(source, selected, version, file))}
              >
                <Download className="size-4" aria-hidden="true" />
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
