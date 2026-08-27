import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { File, Folder, FolderOpen, HardDrive, PlugZap, TriangleAlert } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import Pill from "../components/common/Pill";
import Button from "../components/ui/Button";
import EmptyState from "../components/common/EmptyState";
import TextLink from "../components/ui/TextLink";
import PageNotice from "../components/common/PageNotice";
import AccessSheet, { AccessButton } from "../components/files/AccessSheet";
import ProtectSheet, { ProtectButton } from "../components/files/ProtectSheet";
import FileSearch from "../components/files/FileSearch";
import { TermHint } from "../components/ui/Tooltip";
import { useAuth } from "../context/AuthContext";
import { apiErrorMessage, getDrives, getJson, postJson } from "../lib/api";
import { withDevMockDetected, isMockUnknownDrive, mockInspectResult } from "../lib/devMockDrives.js";
import { describeDriveHealth } from "../lib/driveHealth";

/** @param {number} n @param {string} one @param {string} many */
function pluralCount(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Plain-language count line for Look-inside (singular/plural).
 * @param {number} folders
 * @param {number} files
 * @param {number} [unreadable]
 */
export function inspectCountLine(folders, files, unreadable = 0) {
  const folderBit = pluralCount(folders, "folder", "folders");
  const fileBit = pluralCount(files, "file", "files");
  let line = `We found ${folderBit} and ${fileBit} on this drive`;
  if (unreadable > 0) {
    line += ` (${pluralCount(unreadable, "item", "items")} could not be read)`;
  }
  return `${line}.`;
}

const STATE_PILLS = {
  as_is: "success",
  readonly: "warning",
  missing: "warning",
  ejected: "info",
  failed: "error",
};

function PermissionPill({ permission }) {
  const write = permission === "write";
  return (
    <Pill variant={write ? "success" : "info"}>
      {write ? (
        <TermHint content="Can open files and save changes in this folder.">
          Write
        </TermHint>
      ) : (
        <TermHint content="Can open files in this folder, but cannot save changes.">
          Read
        </TermHint>
      )}
    </Pill>
  );
}

function sizeLabel(bytes) {
  if (!bytes) return "";
  const gb = bytes / 1000 / 1000 / 1000;
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`;
  return `${gb.toFixed(0)} GB`;
}

function DetectedCard({ drive, onOpen, onIgnore }) {
  return (
    <Card icon={HardDrive} title={drive.model || `Drive ${drive.name}`} headerActions={
      <Button size="sm" variant="ghost" onClick={() => onIgnore(drive)}>
        Ignore for now
      </Button>
    }>
      <p className="text-primary text-sm">
        {sizeLabel(drive.size_bytes) || "A new drive"} · found on {drive.name}
      </p>
      <p className="text-primary text-sm mt-2">
        Look inside first. Luna will not change anything until you add it.
      </p>
      <div className="mt-3">
        <Button size="sm" variant="outline" onClick={() => onOpen(drive)}>Look inside</Button>
      </div>
    </Card>
  );
}

function AdoptedCard({ drive, showHealth, onEject, ejecting, onRemove, onShare, onProtect }) {
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
          {copy.detail ? (
            <p className="text-primary text-xs mt-2">{copy.detail}</p>
          ) : null}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(drive.state === "as_is" || drive.state === "readonly") && (
          <Button size="sm" variant="primary" asChild>
            <Link to={`/drives/${drive.id}`}>Browse files</Link>
          </Button>
        )}
        {showHealth && (drive.state === "as_is" || drive.state === "readonly") && (
          <Button size="sm" variant="outline" loading={ejecting} onClick={() => onEject(drive)}>
            Eject safely
          </Button>
        )}
        {showHealth && (
          <Button size="sm" variant="accent" onClick={() => onRemove(drive)}>
            Remove
          </Button>
        )}
        {onShare && (drive.state === "as_is" || drive.state === "readonly") && (
          <AccessButton label={drive.label} onClick={() => onShare(drive)} />
        )}
        {onProtect && (drive.state === "as_is" || drive.state === "readonly") && (
          <ProtectButton label={drive.label} onClick={() => onProtect(drive)} />
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
  if (state === "readonly") {
    return (
      <TermHint content="Luna can open files on this drive but cannot save changes here.">
        Read only
      </TermHint>
    );
  }
  if (state === "missing") return "Unplugged";
  if (state === "ejected") return "Ejected";
  if (state === "failed") return "Problem";
  return state;
}

export default function DrivesPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const drives = useQuery({
    queryKey: ["drives"],
    queryFn: getDrives,
    // Keep pace with detected reconcile so Ejected sticks after umount/reconcile.
    refetchInterval: 5000,
  });
  const detected = useQuery({
    queryKey: ["drives-detected"],
    queryFn: () => getJson("/api/v1/drives/detected"),
    refetchInterval: 5000,
    enabled: isAdmin,
  });
  const [inspectFor, setInspectFor] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [sharingDrive, setSharingDrive] = useState(null);
  const [protectingDrive, setProtectingDrive] = useState(null);
  /** Frontend-only fallback mock can be dismissed without calling lunad. */
  const [dismissedMock, setDismissedMock] = useState(false);
  const unknownDrives = withDevMockDetected(detected.data).filter(
    (d) => !(dismissedMock && d.name === "sdmock" && !detected.data?.some((real) => real.name === "sdmock")),
  );
  const access = useQuery({
    queryKey: ["my-access"],
    queryFn: () => getJson("/api/v1/me/access"),
    enabled: user?.role === "user",
  });

  const inspect = useMutation({
    mutationFn: (/** @type {any} */ drive) => {
      // Frontend-only review fixture: no real block device, so skip lunad.
      if (
        isMockUnknownDrive(drive?.name)
        && !detected.data?.some((real) => real.name === drive.name)
      ) {
        return Promise.resolve(mockInspectResult());
      }
      return postJson(`/api/v1/drives/${drive.name}/inspect`, {});
    },
  });

  const adopt = useMutation({
    mutationFn: (/** @type {{ drive: any, label: string, erase?: boolean }} */ { drive, label, erase }) =>
      postJson(`/api/v1/drives/${drive.name}/adopt`, { label, erase: Boolean(erase) }),
    onSuccess: () => {
      setInspectFor(null);
      setActionError(null);
      adopt.reset();
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["drives-detected"] });
    },
  });

  const dismiss = useMutation({
    mutationFn: (/** @type {any} */ drive) =>
      postJson(`/api/v1/drives/${drive.name}/dismiss`, {}),
    onSuccess: (_data, drive) => {
      if (drive && !detected.data?.some((real) => real.name === drive.name)) {
        setDismissedMock(true);
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["drives-detected"] });
    },
  });

  const eject = useMutation({
    mutationFn: (/** @type {any} */ drive) => postJson(`/api/v1/drives/${drive.id}/eject`, {}),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["drives-detected"] });
    },
    onError: (err) => setActionError(apiErrorMessage(err, "Luna couldn't eject this drive safely.")),
  });

  const remove = useMutation({
    mutationFn: (/** @type {any} */ drive) => postJson(`/api/v1/drives/${drive.id}/remove`, {}),
    onSuccess: () => {
      setRemoveTarget(null);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["drives-detected"] });
    },
    onError: (err) => setActionError(apiErrorMessage(err, "Luna couldn't remove this drive.")),
  });

  const adoptError = adopt.isError
    ? apiErrorMessage(adopt.error, "Luna couldn't add this drive. Try again.")
    : null;

  if (user?.role === "user") {
    const grants = access.data || [];
    return (
      <Page title="Files" titleId="drives-title">
        <FileSearch />
        <div className="grid gap-4 md:grid-cols-2">
          {grants.map((grant) => (
            <Card key={grant.id} icon={FolderOpen} title={grant.drive_label}>
              <p className="text-primary font-mono text-sm">
                {grant.path || "Whole drive"}
              </p>
              <div className="mt-3 flex items-center justify-between gap-3">
                <PermissionPill permission={grant.permission} />
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
            onClose={() => setSharingDrive(null)}
          />
        )}
      </Page>
    );
  }

  return (
    <Page title="Files" titleId="drives-title">
      <FileSearch />
      {actionError && <PageNotice variant="error" className="mb-4">{actionError}</PageNotice>}
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
              onRemove={(d) => setRemoveTarget(d)}
              onShare={(d) => setSharingDrive({ id: d.id, path: "", kind: "drive" })}
              onProtect={(d) => setProtectingDrive({ id: d.id, path: "" })}
            />
          ))}
        </div>
      )}

      {isAdmin && (
        <>
          <h2 className="font-mono text-sm text-secondary mt-10 mb-4">
            Unknown Drives
          </h2>
          <div className="grid gap-5 md:grid-cols-2">
            {unknownDrives.map((drive) => (
              <DetectedCard
                key={drive.name}
                drive={drive}
                onOpen={(d) => {
                  inspect.reset();
                  adopt.reset();
                  setInspectFor(d);
                  inspect.mutate(d);
                }}
                onIgnore={(d) => dismiss.mutate(d)}
              />
            ))}
          </div>
          {!detected.isLoading && unknownDrives.length === 0 && (
            <EmptyState description="Nothing new plugged in." />
          )}
        </>
      )}

      {sharingDrive && (
        <AccessSheet
          driveId={sharingDrive.id}
          path={sharingDrive.path}
          onClose={() => setSharingDrive(null)}
        />
      )}
      {protectingDrive && (
        <ProtectSheet
          driveId={protectingDrive.id}
          path={protectingDrive.path}
          onClose={() => setProtectingDrive(null)}
        />
      )}

      {removeTarget && (
        <ModalCard title="Remove this drive?" onClose={() => setRemoveTarget(null)}>
          {({ close }) => (
            <>
              <p className="text-primary text-sm">
                Luna will stop managing <span className="font-mono">{removeTarget.label}</span>.
                Your files stay on the drive. Luna only removes its tiny{" "}
                <span className="font-mono">.luna</span> sticker file.
              </p>
              <div className="mt-4 flex gap-3">
                <Button
                  variant="accent"
                  loading={remove.isPending}
                  onClick={() => remove.mutate(removeTarget)}
                >
                  Remove
                </Button>
                <Button variant="outline" onClick={close}>Keep it</Button>
              </div>
            </>
          )}
        </ModalCard>
      )}

      {inspectFor && (
        <InspectModal
          drive={inspectFor}
          result={inspect.data}
          error={inspect.isError ? "Luna couldn't look at this drive safely. Make sure it's plugged in and try again." : null}
          onClose={() => { setInspectFor(null); inspect.reset(); adopt.reset(); }}
          onAdopt={(label, erase) => adopt.mutate({ drive: inspectFor, label, erase })}
          adoptError={adoptError}
          adopting={adopt.isPending}
        />
      )}
    </Page>
  );
}

function InspectModal({ drive, result, error, onClose, onAdopt, adoptError, adopting }) {
  const [label, setLabel] = useState(drive.model || "My Drive");
  const [confirmErase, setConfirmErase] = useState(false);
  const needsErase = Boolean(result?.needs_erase);
  const canUse = Boolean(result) && result.readable && (result.writable || needsErase);
  const blockedReason = result && !canUse
    ? (!result.readable
      ? "Luna could not read this drive. Make sure it is plugged in firmly and try again."
      : "This drive will not accept new files right now. If it has a lock switch, slide it to unlock. If this USB still has the Luna installer on it, look inside and choose Erase and add.")
    : null;

  return (
    <ModalCard onClose={onClose} title={`Look inside ${drive.model || drive.name}`}>
      {({ close }) => (
        <>
      {!result && !error && (
        <p className="text-primary text-sm">Looking… Luna reads in read-only mode and changes nothing until you add it.</p>
      )}

      {error && (
        <>
          <p className="text-primary text-sm">{error}</p>
          <div className="mt-4"><Button variant="outline" onClick={close}>Close</Button></div>
        </>
      )}

      {result && (
        <>
          <p className="text-primary text-sm">
            {inspectCountLine(result.folders, result.files, result.unreadable)}
          </p>
          {Array.isArray(result.entries) && result.entries.length > 0 && (
            <div className="mt-3">
              <ul
                className="max-h-48 overflow-y-auto rounded-large-element bg-primary text-secondary border-2 border-secondary/30 px-3 py-2 space-y-1 motion-safe:transition-colors"
                aria-label="What's on this drive"
              >
                {result.entries.map((entry) => (
                  <li
                    key={`${entry.kind}:${entry.name}`}
                    className="flex items-center gap-2 text-sm font-mono min-w-0"
                  >
                    {entry.kind === "folder" ? (
                      <Folder size={14} className="shrink-0" aria-hidden="true" />
                    ) : (
                      <File size={14} className="shrink-0" aria-hidden="true" />
                    )}
                    <span className="truncate">{entry.name}</span>
                    <span className="sr-only">
                      {entry.kind === "folder" ? "folder" : "file"}
                    </span>
                  </li>
                ))}
              </ul>
              {(Number(result.folders) + Number(result.files) > result.entries.length) && (
                <p className="text-primary text-xs mt-2">
                  Showing names at the top of the drive
                  {result.entries.length >= 24 ? " (first 24)" : ""}.
                  Add it to open folders and see everything.
                </p>
              )}
            </div>
          )}
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
          ) : blockedReason ? (
            <div className="mt-4 flex items-center gap-3">
              <TriangleAlert size={18} className="text-warning shrink-0" />
              <p className="text-primary text-xs">{blockedReason}</p>
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
          {canUse && (
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
              {adoptError && <PageNotice variant="error" className="mt-2">{adoptError}</PageNotice>}
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
                <Button variant="outline" onClick={close}>Not now</Button>
              </div>
            </>
          )}
          {!canUse && (
            <div className="mt-4">
              <Button variant="outline" onClick={close}>Close</Button>
            </div>
          )}
        </>
      )}
        </>
      )}
    </ModalCard>
  );
}
