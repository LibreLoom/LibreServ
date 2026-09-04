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
 * Keep a second copy of a folder (or whole drive) on another Luna drive
 * and/or in the cloud (Luna Connect). Not sharing — admins only.
 */
export default function ProtectSheet({ driveId, path = "", onClose, open = true }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [targetDrive, setTargetDrive] = useState("");
  const objectPath = pathKey(path);

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
  const tooFewDrives = driveList.length < 2;
  const thisDrive = driveList.find((d) => d.id === driveId);
  const mountPoint = thisDrive?.mount_point || "";
  const targetKey = { driveId, objectPath, mountPoint };
  const cloudOn = matchesCloudSource(connect.data?.backup_sources, targetKey);
  const cloudUnlocked = Boolean(connect.data?.backup_unlocked);

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
    saveCloud.mutate(next);
  }

  const thingLabel = objectPath ? "folder" : "drive";

  return (
    <ModalCard
      open={open}
      title={
        <span className="inline-flex items-center gap-2">
          Protect
          <InfoHint content="Keeps a second copy on another drive plugged into Luna, and/or a cloud backup through Luna Connect. If one copy fails, you still have the files." />
        </span>
      }
      onClose={onClose}
    >
      {error && <PageNotice variant="error" className="mb-3">{error}</PageNotice>}

      <div className="space-y-5">
        <p className="text-primary text-sm">
          Luna can keep a second copy of this {thingLabel} so you still have it if something goes wrong.
        </p>

        <section className="space-y-2">
          <h3 className="text-primary font-mono text-sm">On another drive</h3>
          <p className="text-primary text-sm">
            Copies this {thingLabel} onto another drive plugged into Luna.
          </p>
          {tooFewDrives ? (
            <p className="text-primary text-sm">Needs a second drive.</p>
          ) : (
            <>
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
            </>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-primary font-mono text-sm inline-flex items-center gap-2">
            In the cloud
            <InfoHint
              label="What cloud backup means"
              content="An off-site copy of the latest files, stored with Luna Connect. It is not a history of old versions. Cloud backup costs $8 per terabyte each month."
            />
          </h3>
          {cloudUnlocked ? (
            <>
              <p className="text-primary text-sm">
                {cloudOn
                  ? `Luna is copying this ${thingLabel} to the cloud when idle.`
                  : `Copy the latest files from this ${thingLabel} off-site when Luna is idle.`}
              </p>
              <Button
                size="sm"
                variant={cloudOn ? "danger" : "primary"}
                loading={saveCloud.isPending}
                onClick={toggleCloud}
              >
                {cloudOn ? "Stop cloud backup" : "Copy to cloud"}
              </Button>
            </>
          ) : (
            <p className="text-primary text-sm">
              Add a card at connect.luna.libreloom.org, then pair this Luna. After that you can copy any folder or a whole drive off-site.
            </p>
          )}
        </section>
      </div>
    </ModalCard>
  );
}
