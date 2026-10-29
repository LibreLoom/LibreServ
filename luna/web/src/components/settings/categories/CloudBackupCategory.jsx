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
import { formatBytes } from "../../../lib/formatBytes.js";
import { useOptionalAuth } from "../../../context/AuthContext";
import useConnectActive from "../../../hooks/useConnectActive";
import BackupItem from "../../protect/BackupItem.jsx";
import BackupStatusNotice from "../../common/BackupStatusNotice.jsx";
import CloudRestoreCard from "../../cloud/CloudRestoreCard.jsx";
import PrivateRestoreCard from "../../cloud/PrivateRestoreCard.jsx";
import RecoveryPhraseCard from "../../cloud/RecoveryPhraseCard.jsx";

function CloudBackupRow({ backup, onRun, onRunAnyway, missingSource, onCheck, onDelete, busy }) {
  const active = backup.status === "active";
  const item = {
    ...backup,
    kind: "cloud",
    destination: "Cloud",
    source_name: backup.source_name || backup.source_path || "Whole drive",
  };
  const size = formatBytes(backup.size);
  return (
    <BackupItem
      backup={item}
      surface="primary"
      note={
        <>
          <p>
            {backup.source_drive_name ? `On ${backup.source_drive_name}` : "Whole drive"}
            {size ? ` · ${size} in the cloud` : ""}
          </p>
          {active ? (
            <BackupStatusNotice
              state={backup.state}
              lastError={backup.last_error}
              lastOkAt={backup.last_ok_at}
              surface="secondary"
              staleText="Luna copies files to the cloud every 6 hours."
            />
          ) : (
            <p>{backup.stop_reason || "This cloud backup has stopped."}</p>
          )}
        </>
      }
    >
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
        <Button size="sm" variant="outline" surface="primary" loading={busy} disabled={busy} onClick={() => onRunAnyway(backup)}>
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
    </BackupItem>
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

  const auth = useOptionalAuth();
  const isAdmin = auth?.user?.role === "admin";
  // Members can't read /connect/status, so "linked" comes from the status everyone can read.
  const connected = useConnectActive();
  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
    enabled: isAdmin && connected,
  });
  const cloudQuery = useQuery({
    queryKey: ["cloud-backups"],
    queryFn: () => getJson("/api/v1/cloud/backups"),
    refetchInterval: 30_000,
    enabled: connected,
  });

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
      <RecoveryPhraseCard />

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
            {isAdmin
              ? "Cloud backup needs Luna Connect. Add your device token in Settings → About → Advanced."
              : "Cloud backup needs Luna Connect. An Admin can turn it on."}
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
                missingSource={missingSourceId === backup.id || backup.source_missing === true}
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

      {connected && <CloudRestoreCard />}
      {connected && <PrivateRestoreCard />}
    </>
  );
}
