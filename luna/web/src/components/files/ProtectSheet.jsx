import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, HardDrive, Shield } from "lucide-react";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import LayeredPill from "@libreloom/ui/components/ui/LayeredPill.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import IconCircle from "@libreloom/ui/components/ui/IconCircle.jsx";
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
  // A late or failed backup says so here; the notice under it gives the age ("Last backed up 2 days ago.").
  if (backup.state === "stale") return "Out of date";
  if (backup.state === "failing") return "Last backup failed";
  if (backup.last_ok_at) {
    const ago = formatRecentAgo(backup.last_ok_at * 1000);
    return `Backed up ${ago === "Just now" ? "just now" : ago}`;
  }
  if (!backup.first_done && !backup.last_error) return "First backup in progress";
  return "Not backed up yet";
}

/** Says a bigger folder's backup already holds this one, and that this one resumes if that backup goes. */
function CoveredNotice({ parent, thing }) {
  return (
    <p className="text-primary text-sm">
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span>
          Included in the backup of <InlinePill>{parent.name}</InlinePill>
        </span>
        <InfoHint
          surface="secondary"
          label="Why this backup is paused"
          content={`That backup already copies this ${thing}. If it is stopped or deleted, this one starts again by itself.`}
        />
      </span>
    </p>
  );
}

/** Absolute calendar date for a unix time in seconds, e.g. "3 March 2026" in the viewer's language. */
function formatOnDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Shield that opens Protect. */
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

/** Heading for one place copies can go: icon, name, whether it is on, and a one-line explanation. */
/**
 * `paused` is for a destination that has a backup but can't run it right now: it must not read "On".
 * @param {{ icon: any, title: string, hint?: any, on: boolean, paused?: boolean, children?: any }} props
 */
function DestinationHeader({ icon: Icon, title, hint = null, on, paused = false, children }) {
  return (
    <div className="flex items-start gap-3">
      <IconCircle icon={Icon} size="sm" variant="secondary" className="shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-mono font-normal inline-flex items-center gap-1.5">
            {title}
            {hint}
          </h3>
          <Pill variant={paused ? "warning" : on ? "success" : "default"} className="shrink-0">
            {paused ? "Paused" : on ? "On" : "Off"}
          </Pill>
        </div>
        {children}
      </div>
    </div>
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
  const [confirmingOldCopies, setConfirmingOldCopies] = useState(false);
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

  const privateItemQuery = useQuery({
    queryKey: ["private-item", driveId, objectPath],
    queryFn: () =>
      getJson(
        `/api/v1/private-backups/item?drive=${encodeURIComponent(driveId)}&path=${encodeURIComponent(objectPath)}`,
      ),
  });
  const privateItem = privateItemQuery.data;
  // Bigger folders whose backup already holds this one, per backup drive or the cloud.
  const coveredQuery = useQuery({
    queryKey: ["backups", "covered", driveId, objectPath],
    queryFn: () =>
      getJson(
        `/api/v1/backups/covered?drive=${encodeURIComponent(driveId)}&path=${encodeURIComponent(objectPath)}`,
      ),
  });
  const matchingBackups = backups.data || [];
  const driveList = drives.data || [];
  const covers = coveredQuery.data || [];
  const driveCovers = covers.filter((c) => c.kind === "drive");
  const cloudCover = covers.find((c) => c.kind === "cloud");
  // A cover on a drive that already has its own backup row shows on that row instead.
  const ownTargetIds = new Set(matchingBackups.map((b) => b.target_drive));
  const strayDriveCovers = driveCovers.filter((c) => !ownTargetIds.has(c.target_drive));
  const usedTargetIds = new Set([...ownTargetIds, ...driveCovers.map((c) => c.target_drive)]);
  const availableTargets = driveList.filter((d) => d.id !== driveId && !usedTargetIds.has(d.id));
  const tooFewDrives = driveList.length < 2;
  const hasBackups = matchingBackups.length > 0 || driveCovers.length > 0;
  const cloudConnected = Boolean(connect.data?.connect_active);
  // Missing from older status replies: treat as on file, so only a clear false blocks backups.
  const cardOnFile = connect.data?.card_on_file !== false;
  // Why a cloud backup can't run right now, in plain words; null when nothing stops it.
  const cloudPausedReason = connect.isPending
    ? null
    : !cloudConnected
    ? "Paused because this Luna isn't linked to Luna Connect. An Admin can add the device token in Settings → About."
    : !cardOnFile
      ? "Paused because Luna Connect has no payment card on file."
      : null;
  const cloudBackup = (cloudQuery.data || []).find(
    (b) => b.source_drive === driveId && trimSlashes(b.source_path) === trimSlashes(objectPath),
  );
  // Someone else's private item: only its owner can back it up, and its cloud copies are theirs alone.
  const isOthersPrivate = privateItem?.private === true && privateItem?.mine !== true;
  // The owner's own private item: keeps every control.
  const isOwnPrivate = privateItem?.private === true && privateItem?.mine === true;
  const blockedCreate = isOthersPrivate;
  const showCloudSection = !isOthersPrivate;

  // The "Private items" row in See all backups and the private item list show these,
  // so a change made from this sheet must refresh them too.
  const refreshPrivateSummary = () => {
    queryClient.invalidateQueries({ queryKey: ["private-backups-summary"] });
    queryClient.invalidateQueries({ queryKey: ["private-backups-mine"] });
  };

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
      refreshPrivateSummary();
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
      refreshPrivateSummary();
    },
  });
  const deleteBackup = useMutation({
    mutationFn: (/** @type {string} */ id) => deleteJson(`/api/v1/backups/${id}`),
    onSuccess: () => {
      addToast({ type: "success", message: "Backup deleted." });
      setDeleting(null);
      queryClient.invalidateQueries({ queryKey: ["backups"] });
      refreshPrivateSummary();
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
      queryClient.invalidateQueries({ queryKey: ["backups"] });
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
      refreshPrivateSummary();
    },
    // A missing recovery phrase (409 needs_phrase) shows Luna's own message here, like any other refusal.
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
      refreshPrivateSummary();
    },
  });
  const deleteCloud = useMutation({
    mutationFn: (/** @type {string} */ id) => deleteJson(`/api/v1/cloud/backups/${id}`),
    onSuccess: () => {
      addToast({ type: "success", message: "Cloud backup deleted." });
      setDeletingCloud(null);
      queryClient.invalidateQueries({ queryKey: ["backups"] });
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
      refreshPrivateSummary();
    },
    onError: (err) => {
      haptic("error");
      setDeletingCloud(null);
      setError(apiErrorMessage(err));
    },
  });

  const removeOldCopies = useMutation({
    mutationFn: () => deleteJson("/api/v1/private-backups/old-copies"),
    onSuccess: () => {
      addToast({ type: "success", message: "Older versions will be removed" });
      setConfirmingOldCopies(false);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
    },
    onError: () => {
      setConfirmingOldCopies(false);
      setError("Could not remove the older versions. Try again.");
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
          {isOthersPrivate ? (
            <p className="text-primary text-sm">
              {privateItem.owner_name ? (
                <>Only <InlinePill>{privateItem.owner_name}</InlinePill> can back up this item.</>
              ) : (
                "Only the owner can back up this item."
              )}
            </p>
          ) : isOwnPrivate ? (
            <>
              <p className="text-primary text-sm">This {thingLabel} is private, so only you can back it up.</p>
              {cloudConnected && (
                <p className="text-primary text-sm">
                  Its cloud copy opens only with your recovery phrase. Without the phrase, it can't be restored.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-primary text-sm">
                Copy this {thingLabel} to other drives plugged into Luna{cloudConnected ? " and to the cloud" : ""}, so you still have it if something goes wrong.
              </p>
              <p className="text-primary text-sm">
                Private items inside aren't backed up here. Each owner backs up their own.
                <InfoHint content="Private items are ones someone has locked so only they can open them." />
              </p>
            </>
          )}
        </div>

        <div className="space-y-3">
          <section className="rounded-large-element surface-primary p-4 space-y-3 motion-safe:transition-[box-shadow,transform] motion-safe:duration-200">
            <DestinationHeader icon={HardDrive} title="On other drives" on={hasBackups}>
              <p className="text-sm">Copies this {thingLabel} onto other drives plugged into Luna.</p>
            </DestinationHeader>

            {tooFewDrives && !blockedCreate ? (
              <Pill variant="default" className="self-start">Needs another drive</Pill>
            ) : (
              <>
                {matchingBackups.map((b) => (
                  <div
                    key={b.id}
                    className="rounded-large-element surface-secondary p-4 space-y-3"
                  >
                    {b.status === "active" && b.covered_by ? (
                      <>
                        <LayeredPill actionLabel={b.target_drive_name}>Included in a bigger backup</LayeredPill>
                        <CoveredNotice parent={b.covered_by} thing={thingLabel} />
                      </>
                    ) : b.status === "active" ? (
                      <>
                        <LayeredPill actionLabel={b.target_drive_name}>{backupHeadline(b)}</LayeredPill>
                        <BackupStatusNotice
                          state={b.state}
                          lastError={b.last_error}
                          lastOkAt={b.last_ok_at}
                                                  />
                      </>
                    ) : (
                      <>
                        <LayeredPill actionLabel={b.target_drive_name}>
                          {b.status === "source_gone" ? "Original is gone" : "Stopped"}
                        </LayeredPill>
                        <p className="text-primary text-sm">
                          {b.stop_reason || "This backup has stopped."}
                        </p>
                      </>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {b.status === "active" && !b.covered_by && (!isOthersPrivate || b.can_delete) && (
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
                {strayDriveCovers.map((c) => (
                  <div key={c.target_drive} className="rounded-large-element surface-secondary p-4 space-y-3">
                    <LayeredPill actionLabel={driveList.find((d) => d.id === c.target_drive)?.label || "Another drive"}>
                      Included in a bigger backup
                    </LayeredPill>
                    <CoveredNotice parent={c} thing={thingLabel} />
                  </div>
                ))}
                {!blockedCreate && availableTargets.length > 0 && (
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

          {showCloudSection && (
          <section
            ref={cloudOuterRef}
            className="overflow-hidden rounded-large-element surface-primary transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
            style={{ transitionDuration: "var(--motion-duration-medium2)" }}
          >
            <div ref={cloudInnerRef} className="p-4 space-y-3">
              <DestinationHeader
                icon={Cloud}
                title="In the cloud"
                on={(Boolean(cloudBackup) || Boolean(cloudCover)) && cloudPausedReason == null}
                paused={Boolean(cloudBackup) && cloudPausedReason != null}
                hint={
                  <InfoHint
                    surface="primary"
                    label="What cloud backup means"
                    content="An off-site copy of your latest files, kept with Luna Connect. It keeps the latest copy, plus about one older copy from each of the last day, week and month. Cloud backup costs $8 per terabyte each month."
                  />
                }
              >
                {!cloudConnected ? (
                  <p className="text-sm">
                    Link this Luna to Luna Connect. Then you can copy any folder or a whole drive off-site.
                  </p>
                ) : (
                  <>
                    <p className="text-sm">
                      {cloudBackup
                        ? `Luna copies this ${thingLabel} to the cloud every 6 hours.`
                        : `Copy the latest files from this ${thingLabel} off-site. Luna copies them every 6 hours.`}
                    </p>
                    {!cardOnFile && (
                      <p className="text-sm">
                        Add a payment card at Luna Connect: <InlinePill>connect.luna.libreloom.org</InlinePill>.{" "}
                        {cloudBackup ? "Backups stay paused until then." : "Cloud backup can start after that."}
                      </p>
                    )}
                  </>
                )}
              </DestinationHeader>

              {cloudBackup && (
                <div className="rounded-large-element surface-secondary p-4 space-y-3">
                  {cloudBackup.status === "active" && cloudBackup.covered_by ? (
                    <>
                      <LayeredPill actionLabel="Luna Connect">Included in a bigger backup</LayeredPill>
                      <CoveredNotice parent={cloudBackup.covered_by} thing={thingLabel} />
                    </>
                  ) : cloudBackup.status === "active" ? (
                    <>
                    <LayeredPill actionLabel="Luna Connect">
                      {cloudPausedReason ? "Paused" : backupHeadline(cloudBackup)}
                    </LayeredPill>
                    {cloudPausedReason && <p className="text-primary text-sm">{cloudPausedReason}</p>}
                    {cloudBackup.source_missing === true && (
                      <p className="text-primary text-sm">The original folder or drive isn't available right now.</p>
                    )}
                    <BackupStatusNotice
                      state={cloudBackup.state}
                      lastError={cloudBackup.last_error}
                      lastOkAt={cloudBackup.last_ok_at}
                      staleText="Luna copies files to the cloud every 6 hours."
                    />
                    </>
                  ) : (
                    <>
                      <LayeredPill actionLabel="Luna Connect">
                        {cloudBackup.status === "source_gone" ? "Original is gone" : "Stopped"}
                      </LayeredPill>
                      <p className="text-primary text-sm">
                        {cloudBackup.stop_reason || "This cloud backup has stopped."}
                      </p>
                    </>
                  )}
                  {cloudBackup.old_phrase_copies && (
                    <p className="text-primary text-sm">
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        Older versions made with your old recovery phrase
                        {cloudBackup.old_phrase_copies.removed_at
                          ? ` · removed ${formatOnDate(cloudBackup.old_phrase_copies.removed_at)}`
                          : ""}
                        <InfoHint content="These were made before you got a new recovery phrase. They open only with the old phrase." />
                      </span>
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {cloudBackup.status === "active" && !cloudBackup.covered_by && cloudPausedReason == null && (
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
                    {cloudBackup.status === "active" && cloudPausedReason == null && cloudBackup.can_delete && (missingSourceId === cloudBackup.id || cloudBackup.source_missing === true) && (
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
                    {cloudBackup.old_phrase_copies && (
                      <Button
                        size="sm"
                        variant="accent"
                        surface="secondary"
                        onClick={() => setConfirmingOldCopies(true)}
                      >
                        Remove now
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

              {cloudConnected && !cloudBackup && cloudCover && (
                <div className="rounded-large-element surface-secondary p-4">
                  <CoveredNotice parent={cloudCover} thing={thingLabel} />
                </div>
              )}

              {cloudConnected && !cloudBackup && !cloudCover && !blockedCreate && (
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
          )}
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

      <ConfirmModal
        open={confirmingOldCopies}
        variant="danger"
        title="Remove older cloud versions?"
        confirmLabel="Remove"
        loading={removeOldCopies.isPending}
        onClose={() => setConfirmingOldCopies(false)}
        onConfirm={() => removeOldCopies.mutate()}
      >
        <p className="text-primary text-sm">
          Earlier versions and deleted files that only exist in these older versions will be gone.
        </p>
      </ConfirmModal>
    </>
  );
}
