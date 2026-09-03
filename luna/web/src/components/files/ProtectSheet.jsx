import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield } from "lucide-react";
import ModalCard from "../cards/ModalCard";
import Button from "../ui/Button";
import Dropdown from "../common/Dropdown";
import PageNotice from "../common/PageNotice";
import ShakeTarget from "../ui/ShakeTarget";
import { InfoHint, Tooltip } from "../ui/Tooltip";
import { deleteJson, getDrives, getJson, postJson, apiErrorMessage } from "../../lib/api";
import { absoluteFolderPath, canProtect } from "../../lib/canProtect";

function pathKey(value) {
  return value || "";
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
 * Keep a second copy of a folder (or whole drive) on another drive plugged into Luna,
 * or in cloud backup when that is unlocked. Admins only.
 */
export default function ProtectSheet({ driveId, path = "", onClose, open = true }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [targetDrive, setTargetDrive] = useState("");
  const objectPath = pathKey(path);
  const wholeDrive = objectPath === "";

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
  });
  const protections = useQuery({
    queryKey: ["protections"],
    queryFn: () => getJson("/api/v1/protections"),
  });

  const matchingProtections = (protections.data || []).filter(
    (p) => p.source_drive === driveId && pathKey(p.source_path) === objectPath,
  );
  const driveList = drives.data || [];
  const cloudBackupConnected = Boolean(connect.data?.backup_unlocked);
  const hasTwoDrives = driveList.length >= 2;
  // Logical OR — not bitwise. Show Protect options when either destination exists.
  const protectAvailable = canProtect({
    driveCount: driveList.length,
    cloudBackupConnected,
  });

  const sourceDrive = driveList.find((d) => d.id === driveId);
  const absPath = absoluteFolderPath(sourceDrive?.mount_point, objectPath);
  const cloudSources = connect.data?.backup_sources || [];
  const cloudOn = cloudSources.some((s) => {
    if (wholeDrive) return s.kind === "drive" && s.drive_id === driveId;
    return s.kind === "folder" && s.path === absPath;
  });

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
  const saveCloudSources = useMutation({
    mutationFn: (sources) => postJson("/api/v1/connect/backup-sources", { sources }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connect-status"] });
      setError(null);
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  function driveName(id) {
    return driveList.find((d) => d.id === id)?.label || id;
  }

  function toggleCloud() {
    if (wholeDrive) {
      const next = cloudOn
        ? cloudSources.filter((s) => !(s.kind === "drive" && s.drive_id === driveId))
        : [...cloudSources, { kind: "drive", drive_id: driveId }];
      saveCloudSources.mutate(next);
      return;
    }
    if (!absPath) {
      setError("Luna couldn't find this folder on disk. Try again after the drive is ready.");
      return;
    }
    const next = cloudOn
      ? cloudSources.filter((s) => !(s.kind === "folder" && s.path === absPath))
      : [...cloudSources, { kind: "folder", path: absPath }];
    saveCloudSources.mutate(next);
  }

  return (
    <ModalCard
      open={open}
      title={
        <span className="inline-flex items-center gap-2">
          Protect
          <InfoHint content="Keeps a second copy on another drive plugged into Luna, or in cloud backup when that is set up. If one copy fails, you still have the files." />
        </span>
      }
      onClose={onClose}
    >
      {error && <PageNotice variant="error" className="mb-3">{error}</PageNotice>}

      <section className="space-y-4">
        <p className="text-primary text-sm">
          Luna can keep a spare copy on another drive, or in cloud backup when that is connected.
        </p>

        {!protectAvailable ? (
          <p className="text-primary text-sm">
            Needs a second drive, or cloud backup connected in Settings → External Services.
          </p>
        ) : (
          <>
            {hasTwoDrives && (
              <div className="space-y-2">
                <h3 className="text-primary text-sm font-semibold">On another drive</h3>
                {matchingProtections.map((p) => (
                  <div key={p.id} className="rounded-large-element border border-primary/20 p-3 space-y-2">
                    <p className="text-primary text-xs">
                      Copy on {driveName(p.target_drive)}
                      {p.last_run ? ` · ${new Date(p.last_run * 1000).toLocaleString()}` : ""}
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" loading={runProtect.isPending} onClick={() => runProtect.mutate(p.id)}>
                        Refresh now
                      </Button>
                      <Button size="sm" variant="danger" loading={stopProtect.isPending} onClick={() => stopProtect.mutate(p.id)}>
                        Stop
                      </Button>
                    </div>
                  </div>
                ))}
                {matchingProtections.length === 0 && (
                  <>
                    <ShakeTarget shake={error}>
                      <Dropdown
                        options={driveList.filter((d) => d.id !== driveId).map((d) => ({ value: d.id, label: d.label }))}
                        value={targetDrive}
                        onChange={setTargetDrive}
                        placeholder="Copy onto"
                        fullWidth
                        bg="primary"
                      />
                    </ShakeTarget>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={createProtect.isPending}
                      disabled={!targetDrive}
                      onClick={() => createProtect.mutate()}
                    >
                      Protect
                    </Button>
                  </>
                )}
              </div>
            )}

            {cloudBackupConnected && (
              <div className="space-y-2">
                <h3 className="text-primary text-sm font-semibold">Cloud backup</h3>
                <p className="text-primary text-sm">
                  {cloudOn
                    ? "Luna copies the latest files off-site when this Luna is idle."
                    : "Add an off-site copy of the latest files. Cloud backup costs $8 per terabyte each month."}
                </p>
                <Button
                  size="sm"
                  variant={cloudOn ? "danger" : "primary"}
                  loading={saveCloudSources.isPending}
                  onClick={toggleCloud}
                >
                  {cloudOn ? "Stop cloud copy" : "Copy to cloud"}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </ModalCard>
  );
}
