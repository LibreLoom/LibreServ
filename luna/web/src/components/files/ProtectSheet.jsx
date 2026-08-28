import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield } from "lucide-react";
import ModalCard from "../cards/ModalCard";
import Button from "../ui/Button";
import Dropdown from "../common/Dropdown";
import PageNotice from "../common/PageNotice";
import { InfoHint, Tooltip } from "../ui/Tooltip";
import { deleteJson, getDrives, getJson, postJson, apiErrorMessage } from "../../lib/api";

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
 * Keep a second copy of a folder (or whole drive) on another drive plugged into Luna.
 * Not sharing — admins only; needs at least two drives.
 */
export default function ProtectSheet({ driveId, path = "", onClose }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [targetDrive, setTargetDrive] = useState("");
  const objectPath = pathKey(path);

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const protections = useQuery({
    queryKey: ["protections"],
    queryFn: () => getJson("/api/v1/protections"),
  });

  const matchingProtections = (protections.data || []).filter(
    (p) => p.source_drive === driveId && pathKey(p.source_path) === objectPath,
  );
  const driveList = drives.data || [];
  const tooFewDrives = driveList.length < 2;

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

  function driveName(id) {
    return driveList.find((d) => d.id === id)?.label || id;
  }

  return (
    <ModalCard
      title={
        <span className="inline-flex items-center gap-2">
          Protect
          <InfoHint content="Keeps a second copy on another drive plugged into Luna. If one drive fails, you still have the files." />
        </span>
      }
      onClose={onClose}
    >
      {error && <PageNotice variant="error" className="mb-3">{error}</PageNotice>}

      <section className="space-y-2">
        <p className="text-primary text-sm">
          Luna copies this folder onto another drive so you still have it if one drive fails.
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
                <Dropdown
                  options={driveList.filter((d) => d.id !== driveId).map((d) => ({ value: d.id, label: d.label }))}
                  value={targetDrive}
                  onChange={setTargetDrive}
                  placeholder="Copy onto"
                  fullWidth
                />
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
    </ModalCard>
  );
}
