import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PropTypes from "prop-types";
import { ChevronRight, Download, Folder, FileText, RotateCcw } from "lucide-react";
import { getJson, apiErrorMessage, postJson } from "../../lib/api.js";
import { fmtSize } from "../../lib/paths.js";
import { formatRecentAgo } from "../../lib/recentItems.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import ModalErrorNotice from "@libreloom/ui/components/common/ModalErrorNotice.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";

const DAY_S = 24 * 60 * 60;
const KEPT_DAYS = 30;
const NEVER_REPLACE_HINT = "Never replaces anything: if the name is taken, the copy gets a new name.";

const base = (driveId, backupId) => `/api/v1/drives/${driveId}/backups/${backupId}`;

function joinRel(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

function dateText(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function downloadUrl(driveId, backupId, relPath, at) {
  const atPart = at ? `&at=${encodeURIComponent(at)}` : "";
  return `${base(driveId, backupId)}/download?path=${encodeURIComponent(relPath)}${atPart}`;
}

function statusPill(status) {
  if (status === "stopped") return <InlinePill>Stopped</InlinePill>;
  if (status === "source_gone") return <InlinePill>Source deleted</InlinePill>;
  return null;
}

function BackupRow({ backup, onOpen }) {
  const lastGood =
    backup.last_ok_at > 0 ? `Last good copy ${formatRecentAgo(backup.last_ok_at * 1000)}` : "No copy finished yet";
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          haptic("selection");
          onOpen(backup);
        }}
        className="flex w-full items-center gap-3 rounded-large-element px-4 py-3 text-left transition-colors hover:bg-primary/10 focus-visible:outline-none"
      >
        <Folder className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-primary">
              <InlinePill>{backup.source_name}</InlinePill>
            </span>
            {statusPill(backup.status)}
          </span>
          <span className="mt-1 block text-sm text-primary">
            From <InlinePill>{backup.source_drive_name}</InlinePill> · <InlinePill>{backup.source_path}</InlinePill>
          </span>
          <span className="mt-1 block text-sm text-primary">
            {lastGood} · {fmtSize(backup.size_bytes)}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      </button>
    </li>
  );
}

function Crumbs({ backup, sub, onRoot, onSource, onSub }) {
  const parts = sub ? sub.split("/") : [];
  return (
    <nav aria-label="Backup location" className="flex flex-wrap items-center gap-1 text-sm text-primary">
      <button type="button" onClick={onRoot} className="text-primary underline-offset-4 hover:underline">
        Backups
      </button>
      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      {parts.length === 0 ? (
        <span className="text-primary">
          <InlinePill>{backup.source_name}</InlinePill>
        </span>
      ) : (
        <button type="button" onClick={onSource} className="text-primary underline-offset-4 hover:underline">
          <InlinePill>{backup.source_name}</InlinePill>
        </button>
      )}
      {parts.map((part, i) => {
        const target = parts.slice(0, i + 1).join("/");
        const last = i === parts.length - 1;
        return (
          <span key={target} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            {last ? (
              <span className="text-primary">
                <InlinePill>{part}</InlinePill>
              </span>
            ) : (
              <button type="button" onClick={() => onSub(target)} className="text-primary underline-offset-4 hover:underline">
                <InlinePill>{part}</InlinePill>
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function VersionsModal({ driveId, backup, file, onClose }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [restoreError, setRestoreError] = useState("");
  const versions = useQuery({
    queryKey: ["drive-backup-versions", driveId, backup.id, file.rel],
    queryFn: () => getJson(`${base(driveId, backup.id)}/versions?path=${encodeURIComponent(file.rel)}`),
  });

  const restore = useMutation({
    mutationFn: (at) =>
      postJson(
        `/api/v1/drives/${driveId}/backups/${backup.id}/restore`,
        at == null ? { path: file.rel } : { path: file.rel, at },
      ),
    onSuccess: (data) => {
      setRestoreError("");
      addToast({ type: "success", message: `Restored as ${data.name}.` });
      queryClient.invalidateQueries({ queryKey: ["drive-backups", driveId] });
    },
    onError: (err) => {
      setRestoreError(apiErrorMessage(err, "Could not restore this file. Try again."));
    },
  });

  const list = Array.isArray(versions.data) ? versions.data : [];

  return (
    <ModalCard
      open
      title={
        <span className="inline-flex items-center gap-2">
          Versions of <InlinePill>{file.name}</InlinePill>
          <InfoHint content="Each version is a copy Luna kept from an earlier time. Download saves a copy to this device. Restore puts it back in the original folder." />
        </span>
      }
      onClose={onClose}
    >
      <p className="mb-3 text-sm text-primary">{NEVER_REPLACE_HINT}</p>
      {restoreError && <PageNotice variant="error" className="mb-3">{restoreError}</PageNotice>}
      {versions.isPending && (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      )}
      {versions.isError && (
        <PageNotice variant="error" className="mb-3">
          {apiErrorMessage(versions.error, "Could not load the versions. Try again.")}
        </PageNotice>
      )}
      {versions.isSuccess && list.length === 0 && (
        <p className="py-4 text-sm text-primary">No saved versions for this file.</p>
      )}
      {list.length > 0 && (
        <ul className="divide-y divide-accent">
          {list.map((v) => {
            const isLatest = v.at == null;
            const label = isLatest ? "Latest" : dateText(v.at);
            return (
              <li key={v.at ?? "latest"} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-primary">
                    {label} {isLatest && <InlinePill>Current</InlinePill>}
                  </p>
                  <p className="text-sm text-primary">
                    {fmtSize(v.size)}
                    {!isLatest && v.mtime ? ` · Saved ${dateText(v.mtime)}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline" size="sm" surface="secondary">
                    <a href={downloadUrl(driveId, backup.id, file.rel, v.at)} download>
                      <Download className="h-4 w-4" aria-hidden="true" />
                      Download
                    </a>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    surface="secondary"
                    loading={restore.isPending && restore.variables === (v.at ?? null)}
                    disabled={restore.isPending}
                    onClick={() => {
                      setRestoreError("");
                      restore.mutate(v.at ?? null);
                    }}
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    Restore to original folder
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </ModalCard>
  );
}

function EntryRow({ driveId, backup, sub, entry, onOpenFile, onOpenFolder }) {
  const rel = joinRel(sub, entry.name);
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [folderError, setFolderError] = useState("");
  const restoreFolder = useMutation({
    mutationFn: () => postJson(`/api/v1/drives/${driveId}/backups/${backup.id}/restore`, { path: rel }),
    onSuccess: (data) => {
      setFolderError("");
      addToast({ type: "success", message: `Restored as ${data.name}.` });
      queryClient.invalidateQueries({ queryKey: ["drive-backups", driveId] });
    },
    onError: (err) => setFolderError(apiErrorMessage(err, "Could not restore this folder. Try again.")),
  });

  const deletedNote =
    entry.deleted && entry.deleted_at
      ? `Kept until ${dateText(Number(entry.deleted_at) + KEPT_DAYS * DAY_S)}`
      : null;

  const body = (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      {entry.is_dir ? (
        <Folder className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      ) : (
        <FileText className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      )}
      <span className="truncate text-primary">
        <InlinePill>{entry.name}</InlinePill>
      </span>
      {entry.deleted && <InlinePill>Deleted</InlinePill>}
      {!entry.is_dir && <span className="text-sm text-primary">{fmtSize(entry.size)}</span>}
      {deletedNote && <span className="basis-full pl-7 text-sm text-primary">{deletedNote}</span>}
    </span>
  );

  if (entry.is_dir) {
    return (
      <li className="px-2">
        <div className="flex flex-wrap items-center gap-2 py-2">
          <button
            type="button"
            onClick={() => {
              haptic("selection");
              onOpenFolder(rel);
            }}
            className="flex min-w-0 flex-1 items-center text-left"
          >
            {body}
          </button>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm" surface="secondary">
              <a href={downloadUrl(driveId, backup.id, rel)} download>
                <Download className="h-4 w-4" aria-hidden="true" />
                Download
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              surface="secondary"
              loading={restoreFolder.isPending}
              disabled={restoreFolder.isPending}
              onClick={() => {
                setFolderError("");
                restoreFolder.mutate();
              }}
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Restore to original folder
            </Button>
          </div>
          {folderError && <ModalErrorNotice error={folderError} className="basis-full" />}
        </div>
      </li>
    );
  }

  return (
    <li className="px-2">
      <button
        type="button"
        onClick={() => {
          haptic("selection");
          onOpenFile(rel, entry.name);
        }}
        className="flex w-full items-center gap-2 py-2 text-left"
      >
        {body}
        <span className="text-sm text-primary underline-offset-4 hover:underline">Versions</span>
      </button>
    </li>
  );
}

function BackupContents({ driveId, backup, sub, onSub, onRoot, onSource }) {
  const [file, setFile] = useState(null);
  const listing = useQuery({
    queryKey: ["drive-backup-list", driveId, backup.id, sub],
    queryFn: () => getJson(`${base(driveId, backup.id)}/list?path=${encodeURIComponent(sub)}`),
  });
  const entries = Array.isArray(listing.data) ? listing.data : [];

  return (
    <>
      <Crumbs backup={backup} sub={sub} onRoot={onRoot} onSource={onSource} onSub={onSub} />
      <p className="mt-2 text-sm text-primary">
        From <InlinePill>{backup.source_drive_name}</InlinePill> · <InlinePill>{backup.source_path}</InlinePill>
      </p>
      <div className="mt-4">
        {listing.isPending && (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        )}
        {listing.isError && (
          <PageNotice variant="error">
            {apiErrorMessage(listing.error, "Could not load this backup. Try again.")}
          </PageNotice>
        )}
        {listing.isSuccess && entries.length === 0 && (
          <EmptyState title="This folder is empty" description="Nothing is stored here in this backup." />
        )}
        {entries.length > 0 && (
          <ul className="divide-y divide-accent">
            {entries.map((entry) => (
              <EntryRow
                key={entry.name}
                driveId={driveId}
                backup={backup}
                sub={sub}
                entry={entry}
                onOpenFolder={onSub}
                onOpenFile={(rel, name) => setFile({ rel, name })}
              />
            ))}
          </ul>
        )}
      </div>
      {file && (
        <VersionsModal driveId={driveId} backup={backup} file={file} onClose={() => setFile(null)} />
      )}
    </>
  );
}

/**
 * The "Backups" folder on a drive: lists the backups stored on this drive,
 * lets you browse inside one, and restore files or folders to their original place.
 */
export default function BackupsFolder({ driveId, onExit }) {
  const [backup, setBackup] = useState(null);
  const [sub, setSub] = useState("");
  const list = useQuery({
    queryKey: ["drive-backups", driveId],
    queryFn: () => getJson(`/api/v1/drives/${driveId}/backups`),
  });
  const backups = Array.isArray(list.data) ? list.data : [];

  if (backup) {
    return (
      <Card className="p-4 sm:p-5">
        <BackupContents
          key={backup.id}
          driveId={driveId}
          backup={backup}
          sub={sub}
          onSub={setSub}
          onRoot={() => {
            setBackup(null);
            setSub("");
          }}
          onSource={() => setSub("")}
        />
      </Card>
    );
  }

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-mono text-lg text-primary">Backups</h2>
        {onExit && (
          <Button variant="ghost" size="sm" surface="secondary" onClick={onExit}>
            Back to files
          </Button>
        )}
      </div>
      <p className="mt-2 text-sm text-primary">
        Copies of folders kept on this drive. Pick one to look inside.
      </p>
      <div className="mt-4">
        {list.isPending && (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        )}
        {list.isError && (
          <PageNotice variant="error">
            {apiErrorMessage(list.error, "Could not load your backups. Try again.")}
          </PageNotice>
        )}
        {list.isSuccess && backups.length === 0 && (
          <EmptyState title="No backups on this drive" description="Backups you keep on this drive will show up here." />
        )}
        {backups.length > 0 && (
          <ul className="flex flex-col">
            {backups.map((b) => (
              <BackupRow
                key={b.id}
                backup={b}
                onOpen={(picked) => {
                  setSub("");
                  setBackup(picked);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

BackupsFolder.propTypes = {
  driveId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  onExit: PropTypes.func,
};
