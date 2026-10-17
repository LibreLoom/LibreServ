/* eslint-disable react-refresh/only-export-components -- helpers + ProtectButton shared with explorers/tests */
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

/** Absolute folder path under a drive mount for cloud backup sources. */
export function cloudFolderPath(mountPoint, relativePath) {
  const root = (mountPoint || "").replace(/\/+$/, "");
  const rel = (relativePath || "").replace(/^\/+|\/+$/g, "");
  if (!root) return "";
  return rel ? `${root}/${rel}` : root;
}

/** True when `sources` already covers this Back up target. */
export function matchesCloudSource(sources, { driveId, objectPath, mountPoint }) {
  const list = sources || [];
  if (!objectPath) {
    return list.some((s) => s.kind === "drive" && s.drive_id === driveId);
  }
  const abs = cloudFolderPath(mountPoint, objectPath);
  return list.some((s) => s.kind === "folder" && s.path === abs);
}

export function buildCloudSource({ driveId, objectPath, mountPoint }) {
  if (!objectPath) {
    return { kind: "drive", drive_id: driveId };
  }
  return { kind: "folder", path: cloudFolderPath(mountPoint, objectPath) };
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
  const [pendingCloudIntent, setPendingCloudIntent] = useState(null);
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

  const matchingBackups = backups.data || [];
  const driveList = drives.data || [];
  const usedTargetIds = new Set(matchingBackups.map((b) => b.target_drive));
  const availableTargets = driveList.filter((d) => d.id !== driveId && !usedTargetIds.has(d.id));
  const tooFewDrives = driveList.length < 2;
  const thisDrive = driveList.find((d) => d.id === driveId);
  const mountPoint = thisDrive?.mount_point || "";
  const targetKey = { driveId, objectPath, mountPoint };
  const cloudOn = matchesCloudSource(connect.data?.backup_sources, targetKey);
  const cloudUnlocked = Boolean(connect.data?.backup_unlocked);
  const hasBackups = matchingBackups.length > 0;

  // Reset pending intent if target state has been reflected in connect.data
  if (pendingCloudIntent !== null && cloudOn === pendingCloudIntent) {
    setPendingCloudIntent(null);
  }

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
      addToast({
        type: "success",
        message: res?.done
          ? "Backup is up to date."
          : "Luna is still copying. The status updates when it finishes.",
      });
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

  const saveCloud = useMutation({
    mutationFn: async (sources) => {
      const res = await postJson("/api/v1/connect/backup-sources", { sources });
      await queryClient.refetchQueries({ queryKey: ["connect-status"] });
      return res;
    },
    onSuccess: () => {
      addToast({ type: "success", message: "Cloud backup saved." });
      setError(null);
    },
    onError: (err) => {
      haptic("error");
      setPendingCloudIntent(null);
      setError(apiErrorMessage(err));
    },
    onSettled: () => {
      setPendingCloudIntent(null);
    },
  });

  const isCloudLoading =
    saveCloud.isPending || (pendingCloudIntent !== null && cloudOn !== pendingCloudIntent);

  function toggleCloud() {
    if (isCloudLoading) return;
    const current = connect.data?.backup_sources || [];
    const nextSource = buildCloudSource(targetKey);
    if (!nextSource.path && nextSource.kind === "folder") {
      setError("Luna couldn't find this folder on the drive. Try again after the drive is ready.");
      return;
    }
    let next;
    if (cloudOn) {
      next = objectPath
        ? current.filter((s) => !(s.kind === "folder" && s.path === nextSource.path))
        : current.filter((s) => !(s.kind === "drive" && s.drive_id === driveId));
    } else {
      next = [...current, nextSource];
    }
    setPendingCloudIntent(!cloudOn);
    saveCloud.mutate(next);
  }

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
                          Stopped · <InlinePill>{b.target_drive_name}</InlinePill>
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
                        <Button
                          size="sm"
                          variant="accent"
                          surface="secondary"
                          loading={isRunning(b.id, true)}
                          onClick={() => runBackup.mutate({ id: b.id, allowMassDelete: true })}
                        >
                          Run anyway
                        </Button>
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
                        content="An off-site copy of the latest files, stored with Luna Connect. It is not a history of old versions. Cloud backup costs $8 per terabyte each month."
                      />
                    </h3>
                    {cloudOn && (
                      <Pill variant="success" className="shrink-0 px-2 py-0.5 leading-none">
                        On
                      </Pill>
                    )}
                  </div>
                  {cloudUnlocked ? (
                    <p className="text-secondary text-sm">
                      {cloudOn
                        ? `Luna is copying this ${thingLabel} to the cloud when idle.`
                        : `Copy the latest files from this ${thingLabel} off-site when Luna is idle.`}
                    </p>
                  ) : (
                    <p className="text-secondary text-sm">
                      Add a card at connect.luna.libreloom.org, then pair this Luna. After that you can copy any folder or a whole drive off-site.
                    </p>
                  )}
                </div>
              </div>

              {cloudOn && cloudUnlocked && (
                <BackupStatusNotice
                  state={connect.data?.backup_status?.state}
                  lastError={connect.data?.backup_status?.last_error}
                  lastOkAt={connect.data?.backup_status?.last_ok_at}
                  staleText="Cloud backup hasn't finished in over a day. Luna copies files to the cloud only while nobody is using it."
                />
              )}

              {cloudUnlocked && (
                <Button
                  size="sm"
                  variant={cloudOn ? "danger" : "secondary"}
                  surface="primary"
                  fullWidth
                  loading={isCloudLoading}
                  disabled={isCloudLoading}
                  onClick={toggleCloud}
                >
                  {cloudOn ? "Stop cloud backup" : "Copy to cloud"}
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
    </>
  );
}
