/* eslint-disable react-refresh/only-export-components -- page exports helpers used by tests */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, HardDrive, PlugZap } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import Pill from "../components/common/Pill";
import Button from "../components/ui/Button";
import EmptyState from "../components/common/EmptyState";
import TextLink from "../components/ui/TextLink";
import PageNotice from "../components/common/PageNotice";
import ModalErrorNotice from "../components/common/ModalErrorNotice";
import { showPageLevelError } from "../lib/modalScopedError";
import CollapsibleSection from "../components/common/CollapsibleSection";
import ValueDisplay from "../components/common/ValueDisplay";
import AccessSheet, { AccessButton } from "../components/files/AccessSheet";
import ProtectSheet, { ProtectButton } from "../components/files/ProtectSheet";
import InspectModal from "../components/files/InspectModal.jsx";
import useCanProtect from "../hooks/useCanProtect";
import FileSearch from "../components/files/FileSearch";
import Spinner from "../components/ui/Spinner.jsx";
import { TermHint } from "../components/ui/Tooltip";
import { useAuth } from "../context/AuthContext";
import { apiErrorMessage, getDrives, getJson, postJson } from "../lib/api";
import { withDevMockDetected, isMockUnknownDrive, mockInspectResult } from "../lib/devMockDrives.js";
import { describeDriveHealth } from "../lib/driveHealth";
import { ROOT_TERM_HINT } from "../lib/rootTerm.js";
import { memberAccessRoots } from "../lib/shareTree.js";
import { haptic } from "../utils/haptics.js";

/** @param {number} n @param {string} one @param {string} many */
function pluralCount(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Plain-language count line for the add-drive preview (singular/plural).
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

/** Decimal sizes for drive details (matches DashboardPage). */
function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return "";
  const n = Number(bytes);
  if (n < 1000) return `${Math.round(n)} B`;
  const kb = n / 1000;
  if (kb < 1000) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1000;
  if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1000;
  if (gb < 1000) return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
  const tb = gb / 1000;
  return `${tb < 10 ? tb.toFixed(1) : Math.round(tb)} TB`;
}

/** @param {string | undefined | null} fs */
function prettyFsType(fs) {
  if (!fs) return "";
  const key = String(fs).toLowerCase();
  const names = {
    exfat: "exFAT",
    vfat: "FAT",
    fat: "FAT",
    fat32: "FAT32",
    msdos: "FAT",
    ext2: "ext2",
    ext3: "ext3",
    ext4: "ext4",
    ntfs: "NTFS",
    ntfs3: "NTFS",
    xfs: "XFS",
    btrfs: "Btrfs",
    iso9660: "ISO disc image",
  };
  return names[key] || fs;
}

/**
 * Useful one-line details for an unrecognized drive card.
 * Capacity + USB (when known) + filesystem — not kernel names like "sdmock".
 * @param {{ size_bytes?: number, usb?: boolean, removable?: boolean, fs_type?: string | null }} drive
 */
function detectedDriveMeta(drive) {
  const parts = [];
  const size = sizeLabel(drive.size_bytes);
  if (size) parts.push(size);
  if (drive.usb || drive.removable) parts.push("USB");
  const fs = prettyFsType(drive.fs_type);
  if (fs) parts.push(fs);
  return parts.length > 0 ? parts.join(" · ") : "A new drive";
}

/**
 * Dashboard-style free/total + usage bar (matches DriveHomeCard on DashboardPage).
 * Always visible on ready AdoptedCards — not inside Drive details.
 */
function DriveStorageBar({ summary }) {
  const freeLabel = formatBytes(summary.data?.free_bytes);
  const totalLabel = formatBytes(summary.data?.total_bytes);
  const usedLabel = formatBytes(summary.data?.used_bytes);
  const hasSpace =
    summary.data?.mounted &&
    summary.data?.total_bytes != null &&
    Number(summary.data.total_bytes) > 0 &&
    freeLabel &&
    totalLabel;
  const usedPct = hasSpace
    ? Math.min(100, Math.round((Number(summary.data.used_bytes) / Number(summary.data.total_bytes)) * 100))
    : 0;

  if (hasSpace) {
    return (
      <div data-slot="drive-storage-bar">
        <div className="flex items-center gap-2 mb-1">
          <span
            className="inline-block h-2 w-2 rounded-full bg-primary shrink-0"
            aria-hidden="true"
          />
          <span className="text-xs font-mono uppercase tracking-widest text-accent">
            <TermHint content="How much room is left for new files on this drive.">
              Available storage
            </TermHint>
          </span>
        </div>
        <div className="text-2xl font-mono font-normal leading-tight text-primary">
          {freeLabel} free
        </div>
        <p className="text-primary text-sm mt-1">
          {usedLabel ? `${usedLabel} used · ` : ""}
          {totalLabel} total
        </p>
        <div
          className="mt-3 h-2 rounded-pill bg-primary overflow-hidden"
          role="progressbar"
          aria-valuenow={usedPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${usedPct}% used`}
        >
          <div
            className="h-full rounded-pill bg-accent motion-safe:transition-all motion-safe:duration-500"
            style={{ width: `${usedPct}%` }}
          />
        </div>
      </div>
    );
  }

  if (summary.isLoading) {
    return <p className="text-primary text-sm">Checking space…</p>;
  }
  if (summary.isError) {
    return (
      <p className="text-primary text-sm">
        Couldn&apos;t read free space. Try Browse files.
      </p>
    );
  }
  return (
    <p className="text-primary text-sm">
      Storage will show once Luna can read this drive.
    </p>
  );
}

/**
 * Collapsible tech details for a ready/read-only adopted drive.
 * Card-style CollapsibleSection (pill) + ValueDisplay rows — same pattern as
 * LibreServ settings disclosures / UserDetailPage profile table.
 * Storage lives outside (DriveStorageBar); this covers fs / partitions / connection.
 */
function AdoptedDriveDetails({ drive }) {
  const fsLabel = prettyFsType(drive.fs_type) || "Unknown";
  const device = drive.device ? String(drive.device) : "";

  const partitionsValue = device
    ? (drive.fs_type ? `${device} · ${fsLabel}` : device)
    : (drive.fs_type ? `One volume · ${fsLabel}` : "One volume");
  const connectionValue = device || "Plugged in";

  return (
    <CollapsibleSection title="Drive details" size="sm" mono pill>
      <div className="flex flex-col gap-2" role="list" aria-label="Drive detail values">
        <ValueDisplay
          label={(
            <TermHint content="How files are arranged on this drive. Most USB sticks use exFAT so phones, Macs, and PCs can all open them.">
              File system
            </TermHint>
          )}
          value={fsLabel}
        />
        <ValueDisplay
          label={(
            <TermHint content="Sections of the drive that hold files. Many USB sticks have just one.">
              Partitions
            </TermHint>
          )}
          value={partitionsValue}
        />
        <ValueDisplay
          label={(
            <TermHint content="Luna's short name for this plug. Useful if you need help from support.">
              Device connection
            </TermHint>
          )}
          value={connectionValue}
        />
      </div>
    </CollapsibleSection>
  );
}

function DetectedCard({ drive, onOpen }) {
  return (
    <Card icon={HardDrive} title={drive.model || `Drive ${drive.name}`}>
      <p className="text-primary text-sm">
        {detectedDriveMeta(drive)}
      </p>
      <p className="text-primary text-sm mt-2">
        Click &quot;Add drive&quot; to begin adding the drive.
      </p>
      <p className="text-primary text-sm mt-2">
        You&apos;ll see the contents of the drive before adding it. Luna does not touch the contents until you confirm you want to add the drive.
      </p>
      <div className="mt-3">
        <Button size="sm" variant="outline" onClick={() => onOpen(drive)}>Add drive</Button>
      </div>
    </Card>
  );
}

function AdoptedCard({ drive, showHealth, onEject, onRemove, onShare, onProtect }) {
  const state = STATE_PILLS[drive.state] || "info";
  const ready = drive.state === "as_is" || drive.state === "readonly";
  const health = useQuery({
    queryKey: ["drive-health", drive.id],
    queryFn: () => getJson(`/api/v1/drives/${drive.id}/health`),
    enabled: !!showHealth && drive.state === "as_is",
    retry: false,
  });
  const summary = useQuery({
    queryKey: ["drive-summary", drive.id],
    queryFn: () => getJson(`/api/v1/drives/${drive.id}/summary`),
    enabled: ready,
    staleTime: 30_000,
    refetchInterval: ready ? 60_000 : false,
  });
  const copy = showHealth && health.data ? describeDriveHealth(health.data) : null;
  const statusMessage = driveStatusMessage(drive);

  return (
    <Card icon={HardDrive} title={drive.label} headerActions={<Pill variant={state}>{plainDriveState(drive.state)}</Pill>}>
      {statusMessage ? (
        <p className="text-primary text-sm">{statusMessage}</p>
      ) : null}
      {ready ? (
        <div className={statusMessage ? "mt-3 space-y-3" : "space-y-3"}>
          <DriveStorageBar summary={summary} />
          <AdoptedDriveDetails drive={drive} />
        </div>
      ) : null}
      {copy && (
        <div className="mt-3">
          <Pill variant={copy.pill}>{copy.title}</Pill>
          {copy.detail ? (
            <p className="text-primary text-xs mt-2">{copy.detail}</p>
          ) : null}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {ready && (
          <Button size="sm" variant="primary" asChild>
            <Link to={`/drives/${drive.id}`}>Browse files</Link>
          </Button>
        )}
        {showHealth && ready && (
          <Button size="sm" variant="outline" onClick={() => onEject(drive)}>
            Eject safely
          </Button>
        )}
        {showHealth && (
          <Button size="sm" variant="accent" onClick={() => onRemove(drive)}>
            Remove
          </Button>
        )}
        {onShare && ready && (
          <AccessButton label={drive.label} onClick={() => onShare(drive)} />
        )}
        {onProtect && ready && (
          <ProtectButton label={drive.label} onClick={() => onProtect(drive)} />
        )}
      </div>
    </Card>
  );
}

/** Status line for non-ready drives, or the read-only note. Ready drives use Drive details instead. */
function driveStatusMessage(drive) {
  if (drive.state === "missing") return "Unplugged. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in.";
  if (drive.state === "ejected") return "Ejected. Plug it back in to use files again.";
  if (drive.state === "failed") return "This drive ran into a problem. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in.";
  if (drive.state === "readonly") {
    return "Read only — Luna cannot save here. Usually a filesystem issue, or a write-lock switch on the stick.";
  }
  return null;
}

function plainDriveState(state) {
  if (state === "as_is") return "Ready";
  if (state === "readonly") {
    return (
      <TermHint content="Luna can open files here but cannot save changes. Check the filesystem, or a write-lock switch on the stick — not the cable or USB port.">
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
  const [ejectTarget, setEjectTarget] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [sharingDrive, setSharingDrive] = useState(null);
  const [protectingDrive, setProtectingDrive] = useState(null);
  const protectAvailable = useCanProtect();
  const unknownDrives = withDevMockDetected(detected.data);
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
      // InspectModal closes via ModalCard's animated close (not an instant unmount).
      haptic("success");
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["drives-detected"] });
    },
    onError: () => {
      haptic("error");
    },
  });

  const eject = useMutation({
    mutationFn: (/** @type {any} */ drive) => postJson(`/api/v1/drives/${drive.id}/eject`, {}),
    onSuccess: () => {
      haptic("success");
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["drives-detected"] });
    },
    onError: (err) => {
      haptic("error");
      setActionError(apiErrorMessage(err, "Luna couldn't eject this drive safely."));
    },
  });

  const remove = useMutation({
    mutationFn: (/** @type {any} */ drive) => postJson(`/api/v1/drives/${drive.id}/remove`, {}),
    onSuccess: () => {
      haptic("success");
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["drives-detected"] });
    },
    onError: (err) => {
      haptic("error");
      setActionError(apiErrorMessage(err, "Luna couldn't remove this drive."));
    },
  });

  const adoptError = adopt.isError
    ? apiErrorMessage(adopt.error, "Luna couldn't add this drive. Try again.")
    : null;

  if (user?.role === "user") {
    const grants = memberAccessRoots(access.data || []);
    return (
      <Page title="Files" titleId="drives-title" rightContent={<FileSearch />}>
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
          <EmptyState
            icon={FolderOpen}
            title="Nothing shared with you yet"
            description="Ask an Admin to share a folder, drive, or file with you."
          />
        )}
        <AccessSheet
          open={sharingDrive != null}
          driveId={sharingDrive?.id || ""}
          path={sharingDrive?.path || ""}
          onClose={() => setSharingDrive(null)}
        />
      </Page>
    );
  }

  const actionModalOpen = ejectTarget != null || removeTarget != null || inspectFor != null;

  return (
    <Page title="Files" titleId="drives-title" rightContent={<FileSearch />}>
      {showPageLevelError(actionError, actionModalOpen) && (
        <PageNotice variant="error" className="mb-4">{actionError}</PageNotice>
      )}
      {(drives.data || []).length === 0 && (
        <Card icon={PlugZap} title="No drives yet" className="mb-6">
          <p className="text-primary text-sm">
            Plug a USB drive into Luna to get started.
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
              onEject={(d) => setEjectTarget(d)}
              onRemove={(d) => setRemoveTarget(d)}
              onShare={(d) => setSharingDrive({ id: d.id, path: "", kind: "drive" })}
              onProtect={protectAvailable ? (d) => setProtectingDrive({ id: d.id, path: "" }) : undefined}
            />
          ))}
        </div>
      )}

      {isAdmin && (
        <>
          <h2 className="font-mono text-sm text-secondary mt-10 mb-4">
            Unrecognized Drives
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
              />
            ))}
          </div>
          {!detected.isLoading && unknownDrives.length === 0 && (
            <EmptyState description="Nothing new plugged in." />
          )}
        </>
      )}

      <AccessSheet
        open={sharingDrive != null}
        driveId={sharingDrive?.id || ""}
        path={sharingDrive?.path || ""}
        onClose={() => setSharingDrive(null)}
      />
      <ProtectSheet
        open={protectingDrive != null}
        driveId={protectingDrive?.id || ""}
        path={protectingDrive?.path || ""}
        onClose={() => setProtectingDrive(null)}
      />
      <ModalCard
        open={ejectTarget != null}
        title="Eject this drive safely?"
        onClose={() => {
          setActionError(null);
          setEjectTarget(null);
        }}
      >
        {({ close }) => (
          <>
            <p className="text-primary text-sm">
              After a safe eject, you&apos;ll need to physically unplug{" "}
              <span className="font-mono">{ejectTarget?.label}</span> and plug it back
              in again to use it.
            </p>
            <ModalErrorNotice error={actionError} />
            <div className="mt-4 flex gap-3">
              <Button
                variant="accent"
                loading={eject.isPending}
                onClick={() => {
                  if (!ejectTarget) return;
                  eject.mutateAsync(ejectTarget)
                    .then(() => close())
                    .catch(() => {});
                }}
              >
                Eject safely
              </Button>
              <Button variant="outline" onClick={close}>Cancel</Button>
            </div>
          </>
        )}
      </ModalCard>
      <ModalCard
        open={removeTarget != null}
        title="Remove this drive?"
        onClose={() => {
          setActionError(null);
          setRemoveTarget(null);
        }}
      >
        {({ close }) => (
          <>
            <p className="text-primary text-sm">
              {removeTarget?.state === "missing" || removeTarget?.state === "ejected" ? (
                <>
                  Luna will stop managing{" "}
                  <span className="font-mono">{removeTarget?.label}</span>, but the{" "}
                  <span className="font-mono">.luna</span> drive database will stay on the
                  drive since it is currently unplugged. Your files stay exactly where
                  they are.
                </>
              ) : (
                <>
                  Luna will stop managing{" "}
                  <span className="font-mono">{removeTarget?.label}</span>. Your files
                  stay on the drive. Luna only removes its tiny{" "}
                  <span className="font-mono">.luna</span> drive database.
                </>
              )}
            </p>
            <ModalErrorNotice error={actionError} />
            <div className="mt-4 flex gap-3">
              <Button
                variant="accent"
                loading={remove.isPending}
                onClick={() => {
                  if (!removeTarget) return;
                  remove.mutateAsync(removeTarget)
                    .then(() => close())
                    .catch(() => {});
                }}
              >
                Remove
              </Button>
              <Button variant="outline" onClick={close}>Keep it</Button>
            </div>
          </>
        )}
      </ModalCard>

      <InspectModal
        open={inspectFor != null}
        drive={inspectFor}
        result={inspect.data}
        error={inspect.isError ? "Luna couldn't look at this drive safely. Make sure it's plugged in and try again." : null}
        onClose={() => { setInspectFor(null); inspect.reset(); adopt.reset(); }}
        onAdopt={(label, erase) => adopt.mutateAsync({ drive: inspectFor, label, erase })}
        adoptError={adoptError}
        adopting={adopt.isPending}
      />
    </Page>
  );
}

