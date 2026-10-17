import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud } from "lucide-react";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { apiErrorMessage, deleteJson, getJson, postJson } from "../../../lib/api";
import { formatRecentAgo } from "../../../lib/recentItems.js";
import BackupStatusNotice from "../../common/BackupStatusNotice.jsx";
import RecoveryPhraseCard from "../../cloud/RecoveryPhraseCard.jsx";

/** Human size for a byte count, e.g. "1.2 GB". */
function formatSize(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "Last run" line: when the copy last finished, or that it hasn't yet. */
function lastRunText(backup) {
  if (!backup.last_ok_at) return "Not finished yet";
  const ago = formatRecentAgo(backup.last_ok_at * 1000);
  return `Last finished ${ago === "Just now" ? "just now" : ago}`;
}

function CloudBackupRow({ backup, onRun, onRunAnyway, missingSource, onCheck, onDelete, busy }) {
  const active = backup.status === "active";
  return (
    <div className="rounded-large-element surface-primary p-3 space-y-3">
      <div className="space-y-1">
        <p className="text-secondary text-sm">
          <InlinePill>{backup.source_name || backup.source_path || "Whole drive"}</InlinePill>
          {backup.source_drive_name && (
            <span className="text-secondary text-sm"> on {backup.source_drive_name}</span>
          )}
        </p>
        <p className="text-secondary text-xs">
          {lastRunText(backup)} · {formatSize(backup.size)} in the cloud
        </p>
      </div>

      {active ? (
        <BackupStatusNotice
          state={backup.state}
          lastError={backup.last_error}
          lastOkAt={backup.last_ok_at}
          surface="primary"
          staleText="Luna copies files to the cloud every 6 hours. This backup hasn't finished in over a day."
        />
      ) : (
        <p className="text-secondary text-sm">{backup.stop_reason || "This cloud backup has stopped."}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {active && (
          <Button
            size="sm"
            variant="outline"
            surface="primary"
            loading={busy || backup.running}
            disabled={busy || backup.running}
            onClick={() => onRun(backup)}
          >
            Back up now
          </Button>
        )}
        {active && missingSource && (
          <Button
            size="sm"
            variant="outline"
            surface="primary"
            loading={busy}
            disabled={busy}
            onClick={() => onRunAnyway(backup)}
          >
            Back up anyway
          </Button>
        )}
        {active && (
          <Button
            size="sm"
            variant="outline"
            surface="primary"
            loading={busy}
            disabled={busy || backup.running}
            onClick={() => onCheck(backup)}
          >
            Check
          </Button>
        )}
        {backup.can_delete && (
          <Button size="sm" variant="danger" surface="primary" onClick={() => onDelete(backup)}>
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Cloud backups are started from the shield (Back up) button on a drive or folder,
 * then Back up to the cloud. This card lists them and runs, checks, or deletes them.
 */
export default function CloudBackupCategory() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null);
  // Set when a run stopped because the source looks missing; holds the backup id for "Back up anyway".
  const [missingSourceId, setMissingSourceId] = useState(null);

  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
  });
  const cloudQuery = useQuery({
    queryKey: ["cloud-backups"],
    queryFn: () => getJson("/api/v1/cloud/backups"),
    refetchInterval: 30_000,
  });

  const connected = Boolean(connect.data?.connect_active);
  // Missing from older status replies: treat as on file, so only a clear false blocks backups.
  const cardOnFile = connect.data?.card_on_file !== false;
  const backups = cloudQuery.data || [];

  const runBackup = useMutation({
    mutationFn: (/** @type {{id: string, acceptMissing?: boolean}} */ { id, acceptMissing = false }) =>
      postJson(`/api/v1/cloud/backups/${id}/run${acceptMissing ? "?accept_missing=true" : ""}`, {}),
    onSuccess: (res, { id, acceptMissing = false }) => {
      // A problem stays on this card, next to the backup, not in a success toast.
      if (res?.problem) {
        haptic("error");
        setError(res.problem);
        setMissingSourceId(res.source_missing === true && !acceptMissing ? id : null);
        return;
      }
      setMissingSourceId(null);
      setError(null);
      addToast({
        type: "success",
        message: res?.done
          ? "Cloud backup is up to date."
          : "Luna is still copying. The status updates when it finishes.",
      });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["cloud-backups"] }),
  });

  const checkBackup = useMutation({
    mutationFn: (/** @type {string} */ id) => postJson(`/api/v1/cloud/backups/${id}/check`, {}),
    onSuccess: (res) => {
      if (res?.problem) {
        haptic("error");
        setError(res.problem);
        return;
      }
      setError(null);
      addToast({ type: "success", message: "Cloud backup check passed." });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["cloud-backups"] }),
  });

  const deleteBackup = useMutation({
    mutationFn: (/** @type {string} */ id) => deleteJson(`/api/v1/cloud/backups/${id}`),
    onSuccess: () => {
      addToast({ type: "success", message: "Cloud backup deleted." });
      setDeleting(null);
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
    },
    onError: (err) => {
      haptic("error");
      setDeleting(null);
      setError(apiErrorMessage(err));
    },
  });

  const busy = runBackup.isPending || checkBackup.isPending;

  return (
    <>
      <SettingsCard
        icon={Cloud}
        title="Cloud backup"
        headerActions={
          <InfoHint
            label="What cloud backup means"
            content="An off-site copy of your latest files, kept with Luna Connect. It keeps the latest copy, plus about one older copy from each of the last day, week and month. Cloud backup costs $8 per terabyte each month."
          />
        }
      >
        {error && <PageNotice variant="error" className="mb-3">{error}</PageNotice>}

        {!connected ? (
          <p className="text-primary text-sm">
            Link this Luna to Luna Connect. Then open a drive or folder, press the shield (Back up) button, and use Back up to the cloud.
          </p>
        ) : backups.length === 0 ? (
          <div className="space-y-3">
            {!cardOnFile && (
              <p className="text-primary text-sm">
                Add a payment card at Luna Connect: <InlinePill>connect.luna.libreloom.org</InlinePill>. Cloud backup can start after that.
              </p>
            )}
            <p className="text-primary text-sm">
              Nothing is backed up to the cloud yet. Open a drive or folder, press the shield (Back up) button, then use Back up to the cloud.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {!cardOnFile && (
              <p className="text-primary text-sm">
                Add a payment card at Luna Connect: <InlinePill>connect.luna.libreloom.org</InlinePill>. Backups stay paused until then.
              </p>
            )}
            <p className="text-primary text-sm">
              Luna copies the latest files every 6 hours. Cloud backup costs $8 per terabyte each month.
            </p>
            {backups.map((backup) => (
              <CloudBackupRow
                key={backup.id}
                backup={backup}
                busy={busy}
                missingSource={missingSourceId === backup.id}
                onRun={(b) => runBackup.mutate({ id: b.id })}
                onRunAnyway={(b) => runBackup.mutate({ id: b.id, acceptMissing: true })}
                onCheck={(b) => checkBackup.mutate(b.id)}
                onDelete={(b) => setDeleting(b)}
              />
            ))}
          </div>
        )}
      </SettingsCard>

      <ConfirmModal
        open={deleting != null}
        variant="danger"
        title="Delete cloud backup?"
        confirmLabel="Delete cloud backup"
        loading={deleteBackup.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleteBackup.mutate(deleting.id)}
      >
        {deleting && (
          <p className="text-primary text-sm">
            Deletes the copies of <InlinePill>{deleting.source_name || deleting.source_path || "this drive"}</InlinePill> stored in the cloud, including all earlier versions. Everyone with access to this backup loses it. The original files stay.
          </p>
        )}
      </ConfirmModal>

      <RecoveryPhraseCard />
    </>
  );
}
