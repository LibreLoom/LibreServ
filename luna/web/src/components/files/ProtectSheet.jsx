/* eslint-disable react-refresh/only-export-components -- helpers + ProtectButton shared with explorers/tests */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, HardDrive, Shield } from "lucide-react";
import ModalCard from "../cards/ModalCard";
import Button from "../ui/Button";
import Dropdown from "../common/Dropdown";
import PageNotice from "../common/PageNotice";
import Pill from "../common/Pill";
import ShakeTarget from "../ui/ShakeTarget";
import { InfoHint, Tooltip } from "../ui/Tooltip";
import { deleteJson, getDrives, getJson, postJson, apiErrorMessage } from "../../lib/api";
import { useAnimatedHeight } from "../../hooks/useAnimatedHeight";

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

/** True when `sources` already covers this Protect target. */
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

export function ProtectButton({ label, onClick }) {
  return (
    <Tooltip content="Protect">
      <Button
        variant="ghost"
        surface="secondary"
        size="iconSm"
        aria-label={`Protect ${label}`}
        onClick={onClick}
      >
        <Shield size={14} />
      </Button>
    </Tooltip>
  );
}

/**
 * Keep copies of a folder (or whole drive) on other Luna drives
 * and/or in the cloud (Luna Connect). Not sharing — admins only.
 */
export default function ProtectSheet({ driveId, path = "", onClose, open = true }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [targetDrive, setTargetDrive] = useState("");
  const [pendingCloudIntent, setPendingCloudIntent] = useState(null);
  const objectPath = pathKey(path);

  const { outerRef: cloudOuterRef, innerRef: cloudInnerRef } = useAnimatedHeight();

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const protections = useQuery({
    queryKey: ["protections"],
    queryFn: () => getJson("/api/v1/protections"),
  });
  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
  });

  const matchingProtections = (protections.data || []).filter(
    (p) => p.source_drive === driveId && pathKey(p.source_path) === objectPath,
  );
  const driveList = drives.data || [];
  const usedTargetIds = new Set(matchingProtections.map((p) => p.target_drive));
  const availableTargets = driveList.filter((d) => d.id !== driveId && !usedTargetIds.has(d.id));
  const tooFewDrives = driveList.length < 2;
  const thisDrive = driveList.find((d) => d.id === driveId);
  const mountPoint = thisDrive?.mount_point || "";
  const targetKey = { driveId, objectPath, mountPoint };
  const cloudOn = matchesCloudSource(connect.data?.backup_sources, targetKey);
  const cloudUnlocked = Boolean(connect.data?.backup_unlocked);
  const driveProtected = matchingProtections.length > 0;

  // Reset pending intent if target state has been reflected in connect.data
  if (pendingCloudIntent !== null && cloudOn === pendingCloudIntent) {
    setPendingCloudIntent(null);
  }

  const createProtect = useMutation({
    mutationFn: () =>
      postJson("/api/v1/protections", {
        source_drive_id: driveId,
        source_path: objectPath,
        target_drive_id: targetDrive,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["protections"] });
      setError(null);
      setTargetDrive("");
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const runProtect = useMutation({
    mutationFn: (id) => postJson(`/api/v1/protections/${id}/run`, {}),
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const stopProtect = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/protections/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["protections"] }),
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const saveCloud = useMutation({
    mutationFn: async (sources) => {
      const res = await postJson("/api/v1/connect/backup-sources", { sources });
      await queryClient.refetchQueries({ queryKey: ["connect-status"] });
      return res;
    },
    onSuccess: () => {
      setError(null);
    },
    onError: (err) => {
      setPendingCloudIntent(null);
      setError(apiErrorMessage(err));
    },
    onSettled: () => {
      setPendingCloudIntent(null);
    },
  });

  const isCloudLoading =
    saveCloud.isPending || (pendingCloudIntent !== null && cloudOn !== pendingCloudIntent);

  function driveName(id) {
    return driveList.find((d) => d.id === id)?.label || id;
  }

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

  return (
    <ModalCard
      open={open}
      title={
        <span className="inline-flex items-center gap-2">
          Protect
          <InfoHint content="Keeps copies on other drives plugged into Luna, and/or a cloud backup through Luna Connect. If one copy fails, you still have the files." />
        </span>
      }
      onClose={onClose}
    >
      {error && <PageNotice variant="error" className="mb-3">{error}</PageNotice>}

      <p className="text-primary text-sm mb-5">
        Luna can keep copies of this {thingLabel} on other drives, and in the cloud, so you still have it if something goes wrong.
      </p>

      <div className="space-y-3">
        <section className="rounded-large-element bg-primary text-secondary p-4 space-y-3 motion-safe:transition-[box-shadow,transform] motion-safe:duration-200">
          <div className="flex items-start gap-3">
            <HardDrive size={16} className="mt-0.5 shrink-0 text-secondary" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-secondary text-sm font-semibold">On other drives</h3>
                {driveProtected && (
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
              {matchingProtections.map((p) => (
                <div
                  key={p.id}
                  className="rounded-large-element bg-secondary text-primary p-3 space-y-3"
                >
                  <p className="text-primary text-xs">
                    Copy on {driveName(p.target_drive)}
                    {p.last_run ? ` · ${new Date(p.last_run * 1000).toLocaleString()}` : ""}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      surface="secondary"
                      loading={runProtect.isPending}
                      onClick={() => runProtect.mutate(p.id)}
                    >
                      Refresh now
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      surface="secondary"
                      loading={stopProtect.isPending}
                      onClick={() => stopProtect.mutate(p.id)}
                    >
                      Stop
                    </Button>
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
                      placeholder="Copy onto"
                      fullWidth
                      bg="secondary"
                    />
                  </ShakeTarget>
                  <Button
                    size="sm"
                    variant="secondary"
                    surface="primary"
                    fullWidth
                    loading={createProtect.isPending}
                    disabled={!targetDrive}
                    onClick={() => createProtect.mutate()}
                  >
                    {matchingProtections.length > 0 ? "Add another copy" : "Protect"}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>

        <section
          ref={cloudOuterRef}
          className="overflow-hidden rounded-large-element bg-primary text-secondary transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
          style={{ transitionDuration: "var(--motion-duration-medium2)" }}
        >
          <div ref={cloudInnerRef} className="p-4 space-y-3">
            <div className="flex items-start gap-3">
              <Cloud size={16} className="mt-0.5 shrink-0 text-secondary" aria-hidden="true" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-secondary text-sm font-semibold inline-flex items-center gap-1.5">
                    In the cloud
                    <InfoHint
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
  );
}
