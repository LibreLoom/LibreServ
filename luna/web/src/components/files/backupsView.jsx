import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, History, RotateCcw } from "lucide-react";
import { getJson, apiErrorMessage, postJson } from "../../lib/api.js";
import { BACKUPS_PATH, fmtSize } from "../../lib/paths.js";
import { base, downloadUrl, splitBackupPath } from "./backupsSource.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { useFileOps } from "../../context/FileOpsContext.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { ActionTooltipGroup, InfoHint, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";

const DAY_S = 24 * 60 * 60;
const KEPT_DAYS = 30;
const NEVER_REPLACE_HINT = "Never replaces anything: if the name is taken, the copy gets a new name.";

function dateText(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function VersionsModal({ driveId, backup, file, onClose }) {
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

function FolderRestoreButton({ driveId, backupId, rel, label }) {
  const fileOps = useFileOps();
  // The file task card owns the restore: it shows the wait, the result and any
  // error, even if this list goes away.
  function restore() {
    let restoredName = label;
    fileOps.startRequest({
      kind: "restore-backup",
      driveId,
      title: label,
      run: async () => {
        const data = await postJson(`${base(driveId, backupId)}/restore`, { path: rel });
        if (data?.name) restoredName = data.name;
      },
      successToast: () => `Restored as ${restoredName}.`,
      invalidateKeys: [["drive-backups", driveId], ["files", driveId]],
    });
  }
  return (
    <Tooltip content="Restore to original folder">
      <Button
        variant="ghost"
        surface="secondary"
        size="iconSm"
        aria-label={`Restore ${label} to original folder`}
        onClick={restore}
      >
        <RotateCcw size={ICON_SIZE.sm} />
      </Button>
    </Tooltip>
  );
}

/**
 * Row buttons inside a backup: download, then restore (folders) or versions (files). The rows
 * that are the backups themselves get none.
 * @param {{ driveId: string, ctx: { fullPath: string, displayName: string, entry: { kind: string } }, onVersions: (ctx: object) => void }} props
 */
export function BackupRowActions({ driveId, ctx, onVersions }) {
  const { id, sub } = splitBackupPath(ctx.fullPath.slice(BACKUPS_PATH.length + 1));
  if (!sub) return null;
  return (
    <ActionTooltipGroup>
      <div className="flex items-center gap-0.5 flex-wrap justify-end">
        <Tooltip content="Download">
          <Button variant="ghost" surface="secondary" size="iconSm" asChild aria-label={`Download ${ctx.displayName}`}>
            <a href={downloadUrl(driveId, id, sub)} download>
              <Download size={ICON_SIZE.sm} />
            </a>
          </Button>
        </Tooltip>
        {ctx.entry.kind === "dir" ? (
          <FolderRestoreButton driveId={driveId} backupId={id} rel={sub} label={ctx.displayName} />
        ) : (
          <Tooltip content="Versions">
            <Button
              variant="ghost"
              surface="secondary"
              size="iconSm"
              aria-label={`Versions of ${ctx.displayName}`}
              onClick={() => onVersions(ctx)}
            >
              <History size={ICON_SIZE.sm} />
            </Button>
          </Tooltip>
        )}
      </div>
    </ActionTooltipGroup>
  );
}

