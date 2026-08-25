import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, HardDrive, PlugZap, TriangleAlert } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import Pill from "../components/common/Pill";
import Button from "../components/ui/Button";
import EmptyState from "../components/common/EmptyState";
import TextLink from "../components/ui/TextLink";
import AccessSheet, { AccessButton } from "../components/files/AccessSheet";
import { useAuth } from "../context/AuthContext";
import { getDrives, getJson, postJson } from "../lib/api";
import { describeDriveHealth } from "../lib/driveHealth";

const STATE_PILLS = {
  as_is: "success",
  readonly: "warning",
  missing: "warning",
  ejected: "info",
  failed: "error",
};

function sizeLabel(bytes) {
  if (!bytes) return "";
  const gb = bytes / 1000 / 1000 / 1000;
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`;
  return `${gb.toFixed(0)} GB`;
}

function DetectedCard({ drive, onOpen, onIgnore }) {
  return (
    <Card icon={HardDrive} title={drive.model || `Drive ${drive.name}`} headerActions={
      <Button size="sm" variant="outline" onClick={() => onOpen(drive)}>
        Look inside
      </Button>
    }>
      <p className="text-primary text-sm">
        {sizeLabel(drive.size_bytes) || "A new drive"} · found on {drive.name}
      </p>
      <p className="text-primary text-sm mt-2">
        Look inside first. Luna will not change anything until you add it.
      </p>
      <div className="mt-3">
        <Button size="sm" variant="ghost" onClick={() => onIgnore(drive)}>Ignore for now</Button>
      </div>
    </Card>
  );
}

function AdoptedCard({ drive, showHealth, onEject, ejecting, onShare }) {
  const state = STATE_PILLS[drive.state] || "info";
  const health = useQuery({
    queryKey: ["drive-health", drive.id],
    queryFn: () => getJson(`/api/v1/drives/${drive.id}/health`),
    enabled: !!showHealth && drive.state === "as_is",
    retry: false,
  });
  const copy = showHealth && health.data ? describeDriveHealth(health.data) : null;
  const nextStep = driveNextStep(drive);

  return (
    <Card icon={HardDrive} title={drive.label} headerActions={<Pill variant={state}>{plainDriveState(drive.state)}</Pill>}>
      <p className="text-primary text-sm">
        {nextStep}
      </p>
      {copy && (
        <div className="mt-3">
          <Pill variant={copy.pill}>{copy.title}</Pill>
          <p className="text-primary text-xs mt-2">{copy.detail}</p>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(drive.state === "as_is" || drive.state === "readonly") && (
          <Button size="sm" variant="primary" asChild>
            <a href={`/drives/${drive.id}`}>Open files</a>
          </Button>
        )}
        {showHealth && (drive.state === "as_is" || drive.state === "readonly") && (
          <Button size="sm" variant="outline" loading={ejecting} onClick={() => onEject(drive)}>
            Eject safely
          </Button>
        )}
        {onShare && (drive.state === "as_is" || drive.state === "readonly") && (
          <AccessButton label={drive.label} onClick={() => onShare(drive)} />
        )}
      </div>
    </Card>
  );
}

function driveNextStep(drive) {
  if (drive.state === "missing") return "Unplugged. Plug it back in.";
  if (drive.state === "ejected") return "Ejected. Plug it back in to use files again.";
  if (drive.state === "failed") return "This drive ran into a problem.";
  if (drive.state === "readonly") return "Read only — Luna cannot save here.";
  return `Connected as ${drive.device} · ${drive.fs_type || "drive"}`;
}

function plainDriveState(state) {
  if (state === "as_is") return "Ready";
  if (state === "readonly") return "Read only";
  if (state === "missing") return "Unplugged";
  if (state === "ejected") return "Ejected";
  if (state === "failed") return "Problem";
  return state;
}

export default function DrivesPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const detected = useQuery({
    queryKey: ["drives-detected"],
    queryFn: () => getJson("/api/v1/drives/detected"),
    refetchInterval: 5000,
    enabled: isAdmin,
  });
  const [inspectFor, setInspectFor] = useState(null);
  const [ejectError, setEjectError] = useState(null);
  const [sharingDrive, setSharingDrive] = useState(null);
  const access = useQuery({
    queryKey: ["my-access"],
    queryFn: () => getJson("/api/v1/me/access"),
    enabled: user?.role === "user",
  });

  const inspect = useMutation({
    mutationFn: (/** @type {any} */ drive) => postJson(`/api/v1/drives/${drive.name}/inspect`, {}),
  });

  const adopt = useMutation({
    mutationFn: (/** @type {{ drive: any, label: string, erase?: boolean }} */ { drive, label, erase }) =>
      postJson(`/api/v1/drives/${drive.name}/adopt`, { label, erase: Boolean(erase) }),
    onSuccess: () => {
      setInspectFor(null);
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["drives-detected"] });
    },
  });

  const dismiss = useMutation({
    mutationFn: (/** @type {any} */ drive) => postJson(`/api/v1/drives/${drive.name}/dismiss`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["drives-detected"] }),
  });

  const eject = useMutation({
    mutationFn: (/** @type {any} */ drive) => postJson(`/api/v1/drives/${drive.id}/eject`, {}),
    onSuccess: () => {
      setEjectError(null);
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["drives-detected"] });
    },
    onError: (err) => setEjectError(String(err.message || err)),
  });

  const adoptError = adopt.isError ? String(adopt.error?.message || adopt.error) : null;

  if (user?.role === "user") {
    const grants = access.data || [];
    return (
      <Page title="Files" titleId="drives-title">
        <div className="grid gap-4 md:grid-cols-2">
          {grants.map((grant) => (
            <Card key={grant.id} icon={FolderOpen} title={grant.drive_label}>
              <p className="text-primary font-mono text-sm">
                {grant.path || "Whole drive"}
              </p>
              <div className="mt-3 flex items-center justify-between gap-3">
                <Pill variant={grant.permission === "write" ? "success" : "info"}>
                  {grant.permission === "write" ? "Write" : "Read"}
                </Pill>
                <div className="flex items-center gap-1">
                  <AccessButton
                    label={grant.path || grant.drive_label}
                    onClick={() => setSharingDrive({ id: grant.drive_id, path: grant.path || "", kind: "folder" })}
                  />
                  <TextLink surface="secondary" to={`/drives/${grant.drive_id}?path=${encodeURIComponent(grant.path || "")}`}>
                    Open
                  </TextLink>
                </div>
              </div>
            </Card>
          ))}
        </div>
        {!access.isLoading && grants.length === 0 && (
          <EmptyState icon={FolderOpen} title="Nothing shared with you yet" />
        )}
        {sharingDrive && (
          <AccessSheet
            driveId={sharingDrive.id}
            path={sharingDrive.path}
            kind={sharingDrive.kind}
            onClose={() => setSharingDrive(null)}
          />
        )}
      </Page>
    );
  }

  return (
    <Page title="Files" titleId="drives-title">
      {ejectError && <p className="text-error text-sm mb-4">{ejectError}</p>}
      {(drives.data || []).length === 0 && (
        <Card icon={PlugZap} title="No drives yet" className="mb-6">
          <p className="text-primary text-sm">
            Plug a USB drive into Luna. It will show up in a few seconds.
          </p>
        </Card>
      )}

      {(drives.data || []).length > 0 && (
        <div className="grid gap-5 md:grid-cols-2 mb-6">
          {drives.data.map((drive) => (
            <AdoptedCard
              key={drive.id}
              drive={drive}
              showHealth
              onEject={(d) => eject.mutate(d)}
              ejecting={eject.isPending}
              onShare={(d) => setSharingDrive({ id: d.id, path: "", kind: "drive" })}
            />
          ))}
        </div>
      )}

      {isAdmin && (
        <>
          <h2 className="font-mono text-sm text-secondary mt-10 mb-4">
            Drives plugged in now
          </h2>
          <div className="grid gap-5 md:grid-cols-2">
            {(detected.data || []).map((drive) => (
              <DetectedCard
                key={drive.name}
                drive={drive}
                onOpen={(d) => { inspect.reset(); setInspectFor(d); }}
                onIgnore={(d) => dismiss.mutate(d)}
              />
            ))}
          </div>
          {!detected.isLoading && (detected.data || []).length === 0 && (
            <EmptyState description="Nothing new plugged in." />
          )}
        </>
      )}

      {sharingDrive && (
        <AccessSheet
          driveId={sharingDrive.id}
          path={sharingDrive.path}
          kind={sharingDrive.kind}
          onClose={() => setSharingDrive(null)}
        />
      )}

      {inspectFor && (
        <InspectModal
          drive={inspectFor}
          result={inspect.data}
          loading={inspect.isPending}
          error={inspect.isError ? "Luna couldn't look at this drive safely. Make sure it's plugged in and try again." : null}
          onClose={() => { setInspectFor(null); inspect.reset(); }}
          onInspect={() => inspect.mutate(inspectFor)}
          onAdopt={(label, erase) => adopt.mutate({ drive: inspectFor, label, erase })}
          adoptError={adoptError}
          adopting={adopt.isPending}
        />
      )}
    </Page>
  );
}

function InspectModal({ drive, result, loading, error, onClose, onInspect, onAdopt, adoptError, adopting }) {
  const [label, setLabel] = useState(drive.model || "My Drive");
  const [confirmErase, setConfirmErase] = useState(false);
  const needsInspect = !result && !loading && !error;
  const canAdopt = Boolean(result);
  const needsErase = Boolean(result?.needs_erase);

  return (
    <ModalCard onClose={onClose} title={`Look inside ${drive.model || drive.name}`}>
      {needsInspect && (
        <>
          <p className="text-primary text-sm">
            Luna will look in read-only mode. Nothing is written until you add it.
          </p>
          <div className="mt-4 flex gap-3">
            <Button variant="primary" onClick={onInspect}>Look inside</Button>
            <Button variant="outline" onClick={onClose}>Not now</Button>
          </div>
        </>
      )}

      {loading && <p className="text-primary text-sm">Looking…</p>}

      {error && (
        <>
          <p className="text-primary text-sm">{error}</p>
          <div className="mt-4"><Button variant="outline" onClick={onClose}>Close</Button></div>
        </>
      )}

      {result && (
        <>
          <p className="text-primary text-sm">
            We found {result.folders} folders and {result.files} files on this
            drive{result.unreadable > 0 ? ` (${result.unreadable} could not be read)` : ""}.
          </p>
          {needsErase ? (
            <div className="mt-4 flex items-center gap-3">
              <TriangleAlert size={18} className="text-warning shrink-0" />
              <p className="text-primary text-xs">
                This USB still has the Luna installer on it. That kind of disk
                cannot be changed. Luna can erase it and set it up for your
                photos and files. Everything currently on it will be deleted,
                including the installer.
              </p>
            </div>
          ) : result.has_marker ? (
            <p className="text-primary text-sm mt-2">
              This drive was used with a Luna before. Add it here to keep using the
              files. Luna only updates its tiny sticker file.
            </p>
          ) : (
            <div className="mt-4 flex items-center gap-3">
              <TriangleAlert size={18} className="text-warning shrink-0" />
              <p className="text-primary text-xs">
                Adding it only writes one tiny <span className="font-mono">.luna</span> marker
                file at the top of the drive. Your files are untouched.
              </p>
            </div>
          )}
          {canAdopt && (
            <>
              <label className="block mt-4">
                <span className="text-primary text-xs">What should Luna call this drive?</span>
                <input
                  className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  value={label}
                  maxLength={80}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              {adoptError && <p className="text-error text-xs mt-2">{adoptError}</p>}
              <div className="mt-4 flex gap-3">
                {needsErase && !confirmErase ? (
                  <Button variant="danger" onClick={() => setConfirmErase(true)}>
                    Erase and add this drive
                  </Button>
                ) : (
                  <Button
                    variant={needsErase ? "danger" : "primary"}
                    loading={adopting}
                    onClick={() => onAdopt(label, needsErase)}
                  >
                    {needsErase ? "Yes, erase it" : "Add this drive"}
                  </Button>
                )}
                <Button variant="outline" onClick={onClose}>Not now</Button>
              </div>
            </>
          )}
        </>
      )}
    </ModalCard>
  );
}
