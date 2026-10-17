import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, HardDrive, Shield } from "lucide-react";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import { InfoHint, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { deleteJson, getDrives, getJson, postJson, apiErrorMessage } from "../../lib/api";
import { formatRecentAgo } from "../../lib/recentItems.js";
import { useAnimatedHeight } from "@libreloom/ui/hooks/useAnimatedHeight.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import BackupStatusNotice from "../common/BackupStatusNotice.jsx";

function pathKey(value) {
  return value || "";
}

/** Last-resort path compare: folder paths match without leading or trailing slashes. */
function trimSlashes(value) {
  return (value || "").replace(/^\/+|\/+$/g, "");
}

/** Headline for a backup that is working: when it last finished, or that it hasn't yet. */
function backupHeadline(backup) {
  if (backup.last_ok_at) {
    const ago = formatRecentAgo(backup.last_ok_at * 1000);
    return `Backed up ${ago === "Just now" ? "just now" : ago}`;
  }
  if (!backup.first_done && !backup.last_error) return "First backup in progress";
  return "Not backed up yet";
}

export function ProtectButton({ label, onClick }) {
  return (
    <Tooltip content="Back up">
      <Button
        variant="ghost"
        surface="secondary"
        size="iconSm"
        aria-label={`Back up ${label}`}
        onClick={onClick}
      >
        <Shield size={ICON_SIZE.sm} />
      </Button>
    </Tooltip>
  );
}

/**
 * Back up a folder (or whole drive) onto other Luna drives and/or in the
 * cloud (Luna Connect). Not sharing.
 */
export default function ProtectSheet({ driveId, path = "", onClose, open = true }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [error, setError] = useState(null);
  const [targetDrive, setTargetDrive] = useState("");
  const [deleting, setDeleting] = useState(null);
  const [deletingCloud, setDeletingCloud] = useState(null);
  // Set when a cloud run stopped because the source looks missing; holds the backup id for "Back up anyway".
  const [missingSourceId, setMissingSourceId] = useState(null);
  const objectPath = pathKey(path);

  const { outerRef: cloudOuterRef, innerRef: cloudInnerRef } = useAnimatedHeight();

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const backups = useQuery({
    queryKey: ["backups", driveId, objectPath],
    queryFn: () =>
      getJson(
        `/api/v1/backups?drive=${encodeURIComponent(driveId)}&path=${encodeURIComponent(objectPath)}`,
      ),
    // A long "Back up now" keeps copying after it answers; its row updates here.
    refetchInterval: 30_000,
  });
  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
  });
  const cloudQuery = useQuery({
    queryKey: ["cloud-backups"],
    queryFn: () => getJson("/api/v1/cloud/backups"),
    refetchInterval: 30_000,
  });

  const matchingBackups = backups.data || [];
  const driveList = drives.data || [];
  const usedTargetIds = new Set(matchingBackups.map((b) => b.target_drive));
  const availableTargets = driveList.filter((d) => d.id !== driveId && !usedTargetIds.has(d.id));
  const tooFewDrives = driveList.length < 2;
  const hasBackups = matchingBackups.length > 0;
  const cloudConnected = Boolean(connect.data?.connect_active);
  // Missing from older status replies: treat as on file, so only a clear false blocks backups.
  const cardOnFile = connect.data?.card_on_file !== false;
  const cloudBackup = (cloudQuery.data || []).find(
    (b) => b.source_drive === driveId && trimSlashes(b.source_path) === trimSlashes(objectPath),
  );

  const createBackup = useMutation({
    mutationFn: () =>
      postJson("/api/v1/backups", {
        source_drive_id: driveId,
        source_path: objectPath,
        target_drive_id: targetDrive,
      }),
    onSuccess: () => {
      addToast({ type: "success", message: "Backup started." });
      queryClient.invalidateQueries({ queryKey: ["backups"] });
      setError(null);
      setTargetDrive("");
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err));
    },
  });
  const runBackup = useMutation({
    mutationFn: (/** @type {{ id: string, allowMassDelete?: boolean }} */ { id, allowMassDelete }) =>
      postJson(`/api/v1/backups/${id}/run`, allowMassDelete ? { allow_mass_delete: true } : {}),
    onSuccess: (res) => {
      // A problem stays on this sheet, next to the backup, not in a success toast.
      if (res?.problem) {
        haptic("error");
        setError(res.problem);
        return;
      }
      if (res?.done) {
        addToast({ type: "success", message: "Backup is up to date." });
      } else {
        addToast({
          type: "success",
          message: "Luna is still copying. The status updates when it finishes.",
        });
      }
      setError(null);
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err));
    },
    // Success or failure, the row's status changed.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["backups"] });
    },
  });
  const deleteBackup = useMutation({
    mutationFn: (/** @type {string} */ id) => deleteJson(`/api/v1/backups/${id}`),
    onSuccess: () => {
      addToast({ type: "success", message: "Backup deleted." });
      setDeleting(null);
      queryClient.invalidateQueries({ queryKey: ["backups"] });
    },
    onError: (err) => {
      haptic("error");
      setDeleting(null);
      setError(apiErrorMessage(err));
    },
  });

  const createCloud = useMutation({
    mutationFn: () =>
      postJson("/api/v1/cloud/backups", { source_drive_id: driveId, source_path: objectPath }),
    onSuccess: () => {
      addToast({ type: "success", message: "Cloud backup started." });
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err));
    },
  });
  const runCloud = useMutation({
    mutationFn: (/** @type {{id: string, acceptMissing?: boolean}} */ { id, acceptMissing = false }) =>
      postJson(`/api/v1/cloud/backups/${id}/run${acceptMissing ? "?accept_missing=true" : ""}`, {}),
    onSuccess: (res, { id, acceptMissing = false }) => {
      // A problem stays on this sheet, next to the backup, not in a success toast.
      if (res?.problem) {
        haptic("error");
        setError(res.problem);
        setMissingSourceId(res.source_missing === true && !acceptMissing ? id : null);
        return;
      }
      setMissingSourceId(null);
      addToast({
        type: "success",
        message: res?.done
          ? "Cloud backup is up to date."
          : "Luna is still copying. The status updates when it finishes.",
      });
      setError(null);
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
    },
  });
  const deleteCloud = useMutation({
    mutationFn: (/** @type {string} */ id) => deleteJson(`/api/v1/cloud/backups/${id}`),
    onSuccess: () => {
      addToast({ type: "success", message: "Cloud backup deleted." });
      setDeletingCloud(null);
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
    },
    onError: (err) => {
      haptic("error");
      setDeletingCloud(null);
      setError(apiErrorMessage(err));
    },
  });

  const thingLabel = objectPath ? "folder" : "drive";
  const isRunning = (id, allowMassDelete) =>
    runBackup.isPending && runBackup.variables?.id === id && runBackup.variables?.allowMassDelete === allowMassDelete;

  return (
    <>
      <ModalCard
        open={open}
        title={
          <span className="inline-flex items-center gap-2">
            Back up
            <InfoHint content="Keeps copies on other drives plugged into Luna, and in the cloud through Luna Connect. Each file on a drive keeps its latest version plus up to 3 older ones from the past month, and deleted files are kept for 30 days." />
          </span>
        }
        onClose={onClose}
      >
        {error && <PageNotice variant="error" className="mb-3">{error}</PageNotice>}

        <div className="mb-5 space-y-1">
          <p className="text-primary text-sm">
            Luna can keep copies of this {thingLabel} on other drives, and in the cloud, so you still have it if something goes wrong.
          </p>
          <p className="text-primary text-sm">
            Private items inside aren't included. Their owners back them up separately.
          </p>
        </div>

        <div className="space-y-3">
          <section className="rounded-large-element surface-primary p-4 space-y-3 motion-safe:transition-[box-shadow,transform] motion-safe:duration-200">
            <div className="flex items-start gap-3">
              <HardDrive size={ICON_SIZE.md} className="mt-0.5 shrink-0 text-secondary" aria-hidden="true" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-secondary text-sm font-semibold">On other drives</h3>
                  {hasBackups && (
                    <Pill variant="success" className="shrink-0 px-2 py-0.5 leading-none">
                      On
                    </Pill>
                  )}
                </div>
                <p className="text-secondary text-sm">
                  Copies this {thingLabel} onto other drives plugged into Luna.
                </p>
              </div>
            </div>

            {tooFewDrives ? (
              <p className="text-secondary text-sm">Needs another drive.</p>
            ) : (
              <>
                {matchingBackups.map((b) => (
                  <div
                    key={b.id}
                    className="rounded-large-element surface-secondary p-3 space-y-3"
                  >
                    {b.status === "active" ? (
                      <>
                        <p className="text-primary text-xs">
                          {backupHeadline(b)} · <InlinePill>{b.target_drive_name}</InlinePill>
                        </p>
                        <BackupStatusNotice
                          state={b.state}
                          lastError={b.last_error}
                          lastOkAt={b.last_ok_at}
                          staleText={`This ${thingLabel} hasn't been backed up in over a day.`}
                        />
                      </>
                    ) : (
                      <>
                        <p className="text-primary text-xs">
                          {b.status === "source_gone" ? "Source gone" : "Stopped"} ·{" "}
                          <InlinePill>{b.target_drive_name}</InlinePill>
                        </p>
                        <p className="text-primary text-sm">
                          {b.stop_reason || "This backup has stopped."}
                        </p>
                      </>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {b.status === "active" && (
                        <Button
                          size="sm"
                          variant="outline"
                          surface="secondary"
                          loading={isRunning(b.id, false)}
                          onClick={() => runBackup.mutate({ id: b.id, allowMassDelete: false })}
                        >
                          Back up now
                        </Button>
                      )}
                      {b.hard && b.can_delete && b.last_error?.startsWith("Most of") && (
                        <span className="inline-flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="accent"
                            surface="secondary"
                            loading={isRunning(b.id, true)}
                            onClick={() => runBackup.mutate({ id: b.id, allowMassDelete: true })}
                          >
                            Run anyway
                          </Button>
                          <InfoHint
                            label="What Run anyway does"
                            content="Applies the deletions and keeps the removed files for 30 days."
                          />
                        </span>
                      )}
                      {b.can_delete && (
                        <Button
                          size="sm"
                          variant="danger"
                          surface="secondary"
                          onClick={() => setDeleting(b)}
                        >
                          Delete backup
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {availableTargets.length > 0 && (
                  <div className="space-y-3">
                    <ShakeTarget shake={error}>
                      <Dropdown
                        options={availableTargets.map((d) => ({ value: d.id, label: d.label }))}
                        value={targetDrive}
                        onChange={setTargetDrive}
                        placeholder="Choose a drive"
                        fullWidth
                        bg="secondary"
                      />
                    </ShakeTarget>
                    <Button
                      size="sm"
                      variant="secondary"
                      surface="primary"
                      fullWidth
                      loading={createBackup.isPending}
                      disabled={!targetDrive}
                      onClick={() => createBackup.mutate()}
                    >
                      {hasBackups ? "Add another drive" : "Back up"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>

          <section
            ref={cloudOuterRef}
            className="overflow-hidden rounded-large-element surface-primary transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
            style={{ transitionDuration: "var(--motion-duration-medium2)" }}
          >
            <div ref={cloudInnerRef} className="p-4 space-y-3">
              <div className="flex items-start gap-3">
                <Cloud size={ICON_SIZE.md} className="mt-0.5 shrink-0 text-secondary" aria-hidden="true" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-secondary text-sm font-semibold inline-flex items-center gap-1.5">
                      In the cloud
                      <InfoHint
                        surface="primary"
                        label="What cloud backup means"
                        content="An off-site copy of your latest files, kept with Luna Connect. It keeps the latest copy, plus about one older copy from each of the last day, week and month. Cloud backup costs $8 per terabyte each month."
                      />
                    </h3>
                    {cloudBackup && (
                      <Pill variant="success" className="shrink-0 px-2 py-0.5 leading-none">
                        On
                      </Pill>
                    )}
                  </div>
                  {!cloudConnected ? (
                    <p className="text-secondary text-sm">
                      Link this Luna to Luna Connect. Then you can copy any folder or a whole drive off-site.
                    </p>
                  ) : (
                    <>
                      <p className="text-secondary text-sm">
                        {cloudBackup
                          ? `Luna copies this ${thingLabel} to the cloud every 6 hours.`
                          : `Copy the latest files from this ${thingLabel} off-site. Luna copies them every 6 hours.`}
                      </p>
                      {!cardOnFile && (
                        <p className="text-secondary text-sm">
                          Add a payment card at Luna Connect: <InlinePill>connect.luna.libreloom.org</InlinePill>.{" "}
                          {cloudBackup ? "Backups stay paused until then." : "Cloud backup can start after that."}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>

              {cloudConnected && cloudBackup && (
                <div className="rounded-large-element surface-secondary p-3 space-y-3">
                  {cloudBackup.status === "active" ? (
                    <BackupStatusNotice
                      state={cloudBackup.state}
                      lastError={cloudBackup.last_error}
                      lastOkAt={cloudBackup.last_ok_at}
                      staleText="Luna copies files to the cloud every 6 hours. This cloud backup hasn't finished in over a day."
                    />
                  ) : (
                    <p className="text-primary text-sm">
                      {cloudBackup.stop_reason || "This cloud backup has stopped."}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {cloudBackup.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        surface="secondary"
                        loading={runCloud.isPending || cloudBackup.running}
                        disabled={runCloud.isPending || cloudBackup.running}
                        onClick={() => runCloud.mutate({ id: cloudBackup.id })}
                      >
                        Back up now
                      </Button>
                    )}
                    {cloudBackup.status === "active" && missingSourceId === cloudBackup.id && (
                      <Button
                        size="sm"
                        variant="outline"
                        surface="secondary"
                        loading={runCloud.isPending}
                        disabled={runCloud.isPending}
                        onClick={() => runCloud.mutate({ id: cloudBackup.id, acceptMissing: true })}
                      >
                        Back up anyway
                      </Button>
                    )}
                    {cloudBackup.can_delete && (
                      <Button
                        size="sm"
                        variant="danger"
                        surface="secondary"
                        onClick={() => setDeletingCloud(cloudBackup)}
                      >
                        Delete cloud backup
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {cloudConnected && !cloudBackup && (
                <Button
                  size="sm"
                  variant="secondary"
                  surface="primary"
                  fullWidth
                  loading={createCloud.isPending}
                  disabled={createCloud.isPending}
                  onClick={() => createCloud.mutate()}
                >
                  Back up to the cloud
                </Button>
              )}
            </div>
          </section>
        </div>
      </ModalCard>

      <ConfirmModal
        open={deleting != null}
        variant="danger"
        title="Delete backup?"
        confirmLabel="Delete backup"
        loading={deleteBackup.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleteBackup.mutate(deleting.id)}
      >
        {deleting && (
          <p className="text-primary text-sm">
            Deletes the backup and every saved copy on <InlinePill>{deleting.target_drive_name}</InlinePill>. The original files stay.
          </p>
        )}
      </ConfirmModal>

      <ConfirmModal
        open={deletingCloud != null}
        variant="danger"
        title="Delete cloud backup?"
        confirmLabel="Delete cloud backup"
        loading={deleteCloud.isPending}
        onClose={() => setDeletingCloud(null)}
        onConfirm={() => deleteCloud.mutate(deletingCloud.id)}
      >
        {deletingCloud && (
          <p className="text-primary text-sm">
            Deletes the copies of this {thingLabel} stored in the cloud, including all earlier versions. Everyone with access to this backup loses it. The original files stay.
          </p>
        )}
      </ConfirmModal>
    </>
  );
}
