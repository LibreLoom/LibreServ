/* eslint-disable react-refresh/only-export-components -- page exports helpers used by tests */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, HardDrive, Lock, PlugZap, Shield, Trash2, Unplug, Users } from "lucide-react";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import Callout from "@libreloom/ui/components/common/Callout.jsx";
import DriveStatusPill from "../components/common/DriveStatusPill.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { RowActionSheet } from "@libreloom/ui/components/ui/RowActionMenu.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import ModalErrorNotice from "@libreloom/ui/components/common/ModalErrorNotice.jsx";
import CollapsibleSection from "@libreloom/ui/components/common/CollapsibleSection.jsx";
import ValueDisplay from "@libreloom/ui/components/common/ValueDisplay.jsx";
import ShareSheet, { ShareButton } from "../components/share/ShareSheet.jsx";
import ProtectSheet from "../components/files/ProtectSheet";
import InspectModal from "../components/files/InspectModal.jsx";
import FormatDriveFlow from "../components/drives/FormatDriveFlow.jsx";
import DriveEncryptionSheet from "../components/drives/DriveEncryptionSheet.jsx";
import UnlockPrompt from "../components/drives/UnlockPrompt.jsx";
import DriveCard from "../components/drives/DriveCard.jsx";
import DriveStorageBar from "../components/drives/DriveStorageBar.jsx";
import useCanProtect from "../hooks/useCanProtect";
import { FileSearchButton } from "../components/files/FileSearch";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { InfoHint, TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { useAuth } from "../context/AuthContext";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import useStrandedErrorToast from "../hooks/useStrandedErrorToast";
import usePageTitle from "../hooks/usePageTitle.js";
import useReleaseInspectedDrive from "../hooks/useReleaseInspectedDrive.js";
import { apiErrorMessage, getDrives, getJson, postJson } from "../lib/api";
import { withDevMockDetected, isMockUnknownDrive, mockInspectResult } from "../lib/devMockDrives.js";
import { DRIVE_POLL_MS, detectedDrivesQueryOptions } from "../hooks/detectedDrives.js";
import { describeDriveHealth } from "../lib/driveHealth";
import { formatBytes } from "../lib/formatBytes.js";
import { isLocked, isUnopenable } from "../lib/drives.js";
import useDriveHealth from "../hooks/useDriveHealth.js";
import DriveHealthDetails from "../components/files/DriveHealthDetails.jsx";
import { ROOT_TERM_HINT } from "../lib/rootTerm.js";
import { KIND_ALBUM, canSeeLinks, capsHint, capsLabel, sharedItemAction, sharedItemHref } from "../lib/access.js";
import { memberAccessRoots } from "../lib/shareTree.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

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

function PermissionPill({ caps, file = false }) {
  const variant = caps === "full" ? "success" : caps === "upload" ? "warning" : "info";
  const label = capsLabel(caps, { file });
  const hint = capsHint(caps, { file });
  return (
    <Pill variant={variant}>
      {hint ? <TermHint content={hint}>{label}</TermHint> : label}
    </Pill>
  );
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
 * Identity of a detected drive's media. Includes the size so a different card
 * or disk put into the same slot gets a fresh peek.
 * @param {{ name: string, model?: string, size_bytes?: number }} drive
 */
function detectedDriveKey(drive) {
  return `${drive.name}|${drive.model || ""}|${drive.size_bytes || 0}`;
}

/**
 * Collapsible tech details for a ready/read-only adopted drive.
 * Card-style CollapsibleSection (pill) + ValueDisplay rows — same pattern as
 * Sol settings disclosures / UserDetailPage profile table.
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
    <CollapsibleSection title="Drive details" size="sm" mono pill surface="primary">
      <div className="flex flex-col gap-2" role="list" aria-label="Drive detail values">
        <ValueDisplay surface="primary" label="Protection" value={drive.encrypted ? "Password protected" : "Not protected"} />
        <ValueDisplay
          surface="primary"
          label={(
            <TermHint content="How files are arranged on this drive. Most USB sticks use exFAT so phones, Macs, and PCs can all open them." surface="primary">
              File system
            </TermHint>
          )}
          value={fsLabel}
        />
        <ValueDisplay
          surface="primary"
          label={(
            <TermHint content="Sections of the drive that hold files. Many USB sticks have just one." surface="primary">
              Partitions
            </TermHint>
          )}
          value={partitionsValue}
        />
        <ValueDisplay
          surface="primary"
          label={(
            <TermHint content="The name the system gives this drive while it is plugged in, such as sda1. It can change when you plug the drive in again." surface="primary">
              Device connection
            </TermHint>
          )}
          value={connectionValue}
        />
      </div>
    </CollapsibleSection>
  );
}

/**
 * What the peek found, as card rows a person can act on.
 * `note` only appears when there's something to do about it.
 * @param {{ readable: boolean, encrypted?: boolean, needs_setup?: boolean, has_marker?: boolean, folders: number, files: number, sample?: { name: string }[] }} peek
 * @returns {{ value: string, includes: string, history: string, note: string }}
 */
export function describePeek(peek) {
  if (peek.encrypted) {
    return {
      value: "Protected with a password",
      includes: "",
      history: "",
      note: "Add drive asks for the password.",
    };
  }
  if (!peek.readable && peek.needs_setup) {
    return {
      value: "Blank, or a format Luna can't read",
      includes: "",
      history: "",
      note: "Using it with Luna erases what's on it.",
    };
  }
  if (!peek.readable) {
    return {
      value: "Can't read it",
      includes: "",
      history: "",
      note: "It may be blank or damaged. Using it with Luna erases what's on it.",
    };
  }
  if (peek.needs_setup) {
    return {
      value: "Installer disk",
      includes: "",
      history: "",
      note: "Using it with Luna erases what's on it.",
    };
  }
  const history = peek.has_marker ? "Used with Luna before" : "";
  const total = peek.folders + peek.files;
  if (total === 0) return { value: "Empty", includes: "", history, note: "" };
  const names = (peek.sample || []).map((e) => e.name);
  const more = total - names.length;
  return {
    value: `${pluralCount(peek.folders, "folder", "folders")}, ${pluralCount(peek.files, "file", "files")}`,
    includes: names.length > 0 ? `${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "",
    history,
    note: "",
  };
}

/**
 * Facts for a drive that hasn't been added yet, as table rows.
 * `note` only appears when there's something to do about it.
 * @param {{ isPending: boolean, isError: boolean, data?: any }} peek
 * @returns {{ rows: { label: string, value: string }[], note: string }}
 */
function detectedFacts(peek) {
  if (peek.isPending) {
    return {
      rows: [{ label: "On the drive", value: "Looking inside…" }],
      note: "",
    };
  }
  // A failed look says nothing about the drive itself (Add drive can still
  // open it), so show nothing rather than guess; the query retries below.
  if (peek.isError || !peek.data) return { rows: [], note: "" };
  const info = describePeek(peek.data);
  return {
    rows: [
      { label: "On the drive", value: info.value },
      ...(info.history ? [{ label: "History", value: info.history }] : []),
    ],
    note: info.note,
  };
}

/**
 * Facts for a drive, as the same label/value rows the Drive details use.
 */
function DriveFacts({ rows }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" role="list" aria-label="Drive facts">
      {rows.map((row) => (
        <ValueDisplay
          key={row.label}
          surface="primary"
          label={row.label}
          value={row.value}
        />
      ))}
    </div>
  );
}

/**
 * A drive Luna hasn't added. "Add drive" opens the Add-drive window, which is
 * where a drive that has to be erased first hands off to FormatDriveFlow; the
 * card itself never offers to erase. `onShowProgress` reopens a running erase.
 */
function DetectedCard({ drive, onOpen, onShowProgress }) {
  // A card reader with nothing in it reports a size of 0.
  const empty = !drive.size_bytes;
  const title = drive.model || "New drive";
  const fs = prettyFsType(drive.fs_type);
  const kind = drive.usb ? "USB drive" : drive.removable ? "Removable drive" : "Built-in drive";
  // A read-only look inside (lunad mounts it read-only and lets go again).
  const peek = useQuery({
    queryKey: ["drive-peek", detectedDriveKey(drive)],
    queryFn: () =>
      isMockUnknownDrive(drive.name)
        ? Promise.resolve({ ...mockInspectResult(), sample: mockInspectResult().entries })
        : getJson(`/api/v1/drives/${encodeURIComponent(drive.name)}/peek`),
    enabled: !empty,
    // A good answer is kept for as long as this media stays in; a failed one
    // is tried again so one hiccup doesn't stick until the page reloads.
    staleTime: Infinity,
    retry: 1,
    refetchInterval: (query) => (query.state.status === "error" ? 15_000 : false),
    refetchOnWindowFocus: false,
  });
  // The shelf is the card's one action: add it, or reopen the erase that is
  // already running. Members never see this card; only an Admin gets the id.
  const action = drive.formatting
    ? drive.format_id && onShowProgress
      ? { label: "Show progress", onClick: () => onShowProgress(drive) }
      : null
    : { label: "Add drive", onClick: () => onOpen(drive), disabled: empty };

  const facts = empty || drive.formatting
    ? { rows: [], note: "" }
    : detectedFacts(peek);

  return (
    <DriveCard icon={<HardDrive size={ICON_SIZE.lg} />} title={title} action={action}>
      <div className="flex flex-col gap-2">
        <DriveFacts
          rows={[
            { label: "Size", value: empty ? "Nothing inserted" : formatBytes(drive.size_bytes) },
            ...facts.rows,
          ]}
        />
        {drive.formatting ? (
          <p className="text-sm">Being erased and set up. This drive is unavailable until that finishes.</p>
        ) : null}
        {facts.note ? <Callout tone="warning" surface="primary">{facts.note}</Callout> : null}
        {drive.read_only ? (
          <Callout tone="warning" surface="primary">Read-only: Luna can&apos;t save files to this drive.</Callout>
        ) : null}
        <CollapsibleSection title="Drive details" size="sm" mono pill surface="primary">
          <div className="flex flex-col gap-2" role="list" aria-label="Drive detail values">
            <ValueDisplay surface="primary" label="Kind" value={kind} />
            <ValueDisplay
              surface="primary"
              label={(
                <TermHint content="How files are arranged on this drive. Most USB sticks use exFAT so phones, Macs, and PCs can all open them." surface="primary">
                  File system
                </TermHint>
              )}
              value={fs || "Unknown"}
            />
          </div>
        </CollapsibleSection>
      </div>
    </DriveCard>
  );
}

const CANT_OPEN_MESSAGE =
  "Luna can't open this drive right now, so its files and free space aren't available.";
const ERASING_MESSAGE =
  "Being erased and set up. This drive is unavailable until that finishes.";
const CANT_OPEN_HINT =
  "Unplug the drive, wait a few seconds, and plug it back in. If Luna still cannot open it, the drive may be damaged.";

/**
 * The drive's status pill, plus the sheet its trailing segment opens. The open
 * state lives here, not in the card: a sheet is a portal, so it can be mounted
 * from inside the pill, and opening it then re-renders the pill and the sheet
 * instead of the whole card and its storage bar behind the overlay.
 *
 * @param {{
 *   drive: { id: string, state: string, label?: string, mounted?: boolean, encrypted?: boolean, locked?: boolean },
 *   health: import("../lib/driveHealth.js").DriveHealthReport | null | undefined,
 *   actions: import("@libreloom/ui/components/ui/RowActionMenu.jsx").RowAction[],
 * }} props
 */
function DriveStatusSheet({ drive, health, actions }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DriveStatusPill
        drive={drive}
        health={health}
        onActions={actions.length > 0 ? () => setOpen(true) : undefined}
      />
      <ModalCard open={open} title={drive.label} size="sm" onClose={() => setOpen(false)}>
        {({ close }) => <RowActionSheet actions={actions} close={close} />}
      </ModalCard>
    </>
  );
}

function AdoptedCard({ drive, showHealth, onEject, onRemove, onShare, onProtect, onShowProgress, onEncryption }) {
  const location = useLocation();
  const cardRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const unopenable = isUnopenable(drive);
  // Ready means Luna can open it: the storage bar, Browse and the other drive
  // actions apply.
  const erasing = drive.formatting === true;
  // A locked drive isn't broken: it waits for its password, and the card asks for it.
  const locked = isLocked(drive) && !erasing && drive.state !== "missing" && drive.state !== "ejected";
  const ready = (drive.state === "as_is" || drive.state === "readonly") && !unopenable && !erasing && !locked;
  const health = useDriveHealth(drive, !!showHealth);
  const summary = useQuery({
    queryKey: ["drive-summary", drive.id],
    queryFn: () => getJson(`/api/v1/drives/${drive.id}/summary`),
    enabled: ready,
    staleTime: 30_000,
    refetchInterval: ready ? 60_000 : false,
  });
  // The status pill's trailing segment opens this drive's rare actions.
  const copy = showHealth && health.data ? describeDriveHealth(health.data) : null;
  const showSummary = copy && ["failing", "watch", "unknown"].includes(copy.verdict);
  const statusMessage = driveStatusMessage(drive);
  const hashId = `drive-${drive.id}`;
  const targeted = location.hash === `#${hashId}`;
  /** @type {import("@libreloom/ui/components/ui/RowActionMenu.jsx").RowAction[]} */
  const actions = [
    onShare && ready && { key: "share", label: "Share", icon: Users, run: () => onShare(drive) },
    onProtect && ready && { key: "backup", label: "Back up", icon: Shield, run: () => onProtect(drive) },
    onEncryption && (ready || locked) && { key: "encryption", label: "Encryption", icon: Lock, run: () => onEncryption(drive) },
    showHealth && ready && { key: "eject", label: "Eject safely", icon: Unplug, run: () => onEject(drive) },
    showHealth && { key: "remove", label: "Remove", icon: Trash2, danger: true, run: () => onRemove(drive) },
  ].filter(Boolean);

  // The dashboard links to #drive-{id}. The drives load after the page does, so the
  // browser's own hash scrolling can't find the card; do it once it shows.
  const scrolledFor = useRef("");
  useEffect(() => {
    if (!targeted || scrolledFor.current === location.key || !cardRef.current) return;
    scrolledFor.current = location.key;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    cardRef.current.scrollIntoView?.({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
  }, [targeted, location.key]);

  // The shelf is the card's one action: open the drive, or reopen the erase
  // that is already running. No Erase button — erasing is never an action of
  // its own, only a step inside a flow that needs it (FormatDriveFlow).
  const shelf = erasing
    ? drive.format_id && onShowProgress
      ? { label: "Show progress", onClick: () => onShowProgress(drive) }
      : null
    : ready
      ? { label: "Open", to: `/files/${drive.id}` }
      : null;

  return (
    <div id={hashId} ref={cardRef} className="scroll-mt-4 h-full">
      <DriveCard
        className="h-full"
        icon={<HardDrive size={ICON_SIZE.lg} />}
        title={drive.label}
        status={
          /* One LayeredPill: the drive's status, with its rare actions as the
             pill's trailing segment. It sits in the panel's top-right corner;
             the arrow disc on the tray opens the drive. */
          <DriveStatusSheet drive={drive} health={health.data} actions={actions} />
        }
        action={shelf}
      >
        {statusMessage ? (
          <p className="text-sm">
            {statusMessage}
            {unopenable ? <> <InfoHint content={CANT_OPEN_HINT} surface="primary" /></> : null}
          </p>
        ) : null}
        {locked ? (
          <div className="mt-3">
            <UnlockPrompt driveId={drive.id} surface="primary" />
          </div>
        ) : null}
        {showSummary ? (
          <p className={`text-sm${statusMessage ? " mt-2" : ""}`}>
            {copy.summary}
            {copy.hint ? <> <InfoHint content={copy.hint} surface="primary" /></> : null}
          </p>
        ) : null}
        {ready ? (
          <div className={statusMessage || showSummary ? "mt-3 space-y-3" : "space-y-3"}>
            <DriveStorageBar summary={summary} />
            {copy ? <DriveHealthDetails health={health.data} defaultOpen={targeted} surface="primary" /> : null}
            <AdoptedDriveDetails drive={drive} />
          </div>
        ) : null}
      </DriveCard>
    </div>
  );
}

/**
 * Why Remove leaves the drive database on the drive, or "" when Remove deletes
 * it. Mirrors DriveManager::remove: a missing, ejected, read-only, or locked
 * drive can't be written, so lunad only forgets it.
 * @param {{ state?: string, encrypted?: boolean, locked?: boolean }} drive
 */
function removeKeepsDriveDatabase(drive) {
  if (drive.state === "missing") return "unplugged";
  if (drive.state === "ejected") return "ejected";
  if (isLocked(drive)) return "locked";
  if (drive.state === "readonly") return "read only";
  return "";
}

/** Status line for non-ready drives, or the read-only note. Ready drives use Drive details instead. */
function driveStatusMessage(drive) {
  if (drive.state === "missing") return "Unplugged. Plug it in. If it is already plugged in, unplug it and plug it in again.";
  if (drive.state === "ejected") return "Ejected. To use its files again, unplug it and plug it back in.";
  if (drive.formatting) return ERASING_MESSAGE;
  if (isLocked(drive)) return "Locked. Enter the password to open its files.";
  if (isUnopenable(drive)) return CANT_OPEN_MESSAGE;
  if (drive.state === "readonly") {
    return "Read only: Luna tried to save a test file here and could not. A write-lock switch on the drive or a file system error can cause this.";
  }
  return null;
}

export default function FilesPage() {
  usePageTitle("Files");
  const { addToast } = useToast();
  const releaseInspectedDrive = useReleaseInspectedDrive();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const drives = useQuery({
    queryKey: ["drives"],
    queryFn: getDrives,
    // Keep pace with detected reconcile so Ejected sticks after umount/reconcile.
    refetchInterval: DRIVE_POLL_MS,
  });
  const detected = useQuery(detectedDrivesQueryOptions(isAdmin));
  const [inspectFor, setInspectFor] = useState(null);
  const [ejectTarget, setEjectTarget] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [sharingDrive, setSharingDrive] = useState(null);
  const [protectingDrive, setProtectingDrive] = useState(null);
  // The one erase window. `device` is the disk to look at; `format_id` reopens a run in progress.
  const [eraseDevice, setEraseDevice] = useState(null);
  // Set only when the erase is a Protect: the flow turns it into an encrypted drive.
  const [erasePassword, setErasePassword] = useState(/** @type {string | undefined} */ (undefined));
  const [encryptionDrive, setEncryptionDrive] = useState(null);
  const closeErase = () => { setEraseDevice(null); setErasePassword(undefined); };
  const protectAvailable = useCanProtect(isAdmin);
  const unknownDrives = withDevMockDetected(detected.data);
  // The dashboard's "New drive detected" card links to #unrecognized-drives. The drives load after
  // the page does, so the browser's own hash scrolling can't find the section; do it once it shows.
  const location = useLocation();
  const unrecognizedRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const scrolledFor = useRef("");
  const waitingCount = unknownDrives.length;
  useEffect(() => {
    if (location.hash !== "#unrecognized-drives" || waitingCount === 0) return;
    if (scrolledFor.current === location.key || !unrecognizedRef.current) return;
    scrolledFor.current = location.key;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    unrecognizedRef.current.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
  }, [location.hash, location.key, waitingCount]);
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
    mutationFn: (/** @type {{ drive: any, label: string }} */ { drive, label }) =>
      postJson(`/api/v1/drives/${drive.name}/adopt`, { label }),
    onSuccess: () => {
      // InspectModal closes via ModalCard's animated close (not an instant unmount).
      addToast({ type: "success", message: "Drive added." });
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
      addToast({ type: "success", message: "Drive ejected. You can unplug it now." });
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
      addToast({ type: "success", message: "Drive removed." });
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

  const actionModalOpen = ejectTarget != null || removeTarget != null || inspectFor != null;
  useStrandedErrorToast(actionError, actionModalOpen, () => setActionError(null));

  if (user?.role === "user") {
    const grants = memberAccessRoots(access.data || []).filter((g) => g.kind !== KIND_ALBUM);
    return (
      <Page title="Files" titleId="files-title" rightContent={<FileSearchButton />}>
        <div className="grid gap-4 md:grid-cols-2">
          {grants.map((grant) => {
            // A locked drive asks for its password right here; anyone with access may enter it.
            const locked = (drives.data || []).some((d) => d.id === grant.drive_id && isLocked(d));
            return (
            <Card key={grant.id} icon={FolderOpen} title={grant.name || grant.drive_label}>
              <p className="text-primary text-sm">
                {grant.path ? <InlinePill>{`${grant.drive_label} · ${grant.path}`}</InlinePill> : "Whole drive"}
              </p>
              {locked && (
                <div className="mt-3 space-y-3">
                  <p className="text-primary text-sm">This drive is locked. Enter its password to open your files.</p>
                  <UnlockPrompt driveId={grant.drive_id} />
                </div>
              )}
              <div className="mt-3 flex items-center justify-between gap-3">
                <PermissionPill caps={grant.caps} file={grant.is_file === true} />
                <div className="flex items-center gap-2">
                  {!locked && (
                  <Button size="sm" variant="primary" asChild>
                    <Link to={sharedItemHref(grant)}>{sharedItemAction(grant)}</Link>
                  </Button>
                  )}
                  {!locked && canSeeLinks(grant.caps) && (
                    <ShareButton
                      label={grant.path || grant.drive_label}
                      onClick={() => setSharingDrive({ id: grant.drive_id, path: grant.path || "" })}
                    />
                  )}
                </div>
              </div>
            </Card>
            );
          })}
        </div>
        {access.isError && (
          <EmptyState
            icon={FolderOpen}
            title="Luna couldn't load what is shared with you"
            description={apiErrorMessage(access.error, "Try again in a moment.")}
            action={
              <Button size="sm" variant="primary" loading={access.isFetching} onClick={() => access.refetch()}>
                Try again
              </Button>
            }
          />
        )}
        {access.isSuccess && grants.length === 0 && (
          <EmptyState
            icon={FolderOpen}
            title="Nothing shared with you yet"
            description="Ask an Admin to share a folder, drive, or file with you."
          />
        )}
        <ShareSheet
          open={sharingDrive != null}
          subject={
            sharingDrive
              ? { kind: "path", driveId: sharingDrive.id, path: sharingDrive.path || "" }
              : null
          }
          onClose={() => setSharingDrive(null)}
        />
      </Page>
    );
  }

  return (
    <Page title="Files" titleId="files-title" rightContent={<FileSearchButton />}>
      {drives.isError && !drives.data && (
        <Card icon={HardDrive} title="Luna couldn't load your drives" className="mb-6">
          <p className="text-primary text-sm">
            {apiErrorMessage(drives.error, "Try again in a moment.")}
          </p>
          <Button size="sm" variant="primary" className="mt-3" loading={drives.isFetching} onClick={() => drives.refetch()}>
            Try again
          </Button>
        </Card>
      )}

      {drives.isSuccess && (drives.data || []).length === 0 && (
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
              onShare={(d) => setSharingDrive({ id: d.id, path: "" })}
              onProtect={protectAvailable ? (d) => setProtectingDrive({ id: d.id, path: "" }) : undefined}
              onShowProgress={isAdmin ? (d) => setEraseDevice({ name: d.device, label: d.label, format_id: d.format_id }) : undefined}
              onEncryption={isAdmin ? (d) => setEncryptionDrive(d) : undefined}
            />
          ))}
        </div>
      )}

      {isAdmin && unknownDrives.length > 0 && (
        <>
          <div
            id="unrecognized-drives"
            ref={unrecognizedRef}
            className="mt-10 mb-4 flex items-center gap-2 scroll-mt-6"
          >
            <h2 className="font-mono text-sm text-secondary">Unrecognized drives</h2>
            <InfoHint surface="primary" content="Luna shows what's on a drive before adding it, and changes nothing until you confirm." />
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            {unknownDrives.map((drive) => (
              <DetectedCard
                key={drive.name}
                drive={drive}
                onShowProgress={(d) => setEraseDevice({ name: d.name, model: d.model, label: d.model || "", format_id: d.format_id })}
                onOpen={(d) => {
                  inspect.reset();
                  adopt.reset();
                  setInspectFor(d);
                  inspect.mutate(d);
                }}
              />
            ))}
          </div>
        </>
      )}

      <ShareSheet
        open={sharingDrive != null}
        subject={
          sharingDrive
            ? { kind: "path", driveId: sharingDrive.id, path: sharingDrive.path || "" }
            : null
        }
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
              Luna finishes saving files to{" "}
              <InlinePill>{ejectTarget?.label}</InlinePill>, then closes it. To
              use it again, unplug it and plug it back in.
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
              {removeTarget && removeKeepsDriveDatabase(removeTarget) ? (
                <>
                  Luna stops using{" "}
                  <InlinePill>{removeTarget.label}</InlinePill>. Its drive
                  database stays on the drive because the drive is{" "}
                  {removeKeepsDriveDatabase(removeTarget)}. Your files stay on
                  the drive, but shares and links to it stop working.
                </>
              ) : (
                <>
                  Luna stops using{" "}
                  <InlinePill>{removeTarget?.label}</InlinePill> and deletes its
                  drive database from the drive. This deletes the albums and
                  favorites for this drive, and hides its private items from
                  everyone. Your files stay on the drive, but shares and links
                  to it stop working.
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

      <DriveEncryptionSheet
        open={encryptionDrive != null}
        drive={encryptionDrive}
        onClose={() => setEncryptionDrive(null)}
        // Protect and Remove protection both erase, so they open the one erase window.
        onProtect={(d, password) => { setErasePassword(password); setEraseDevice({ name: d.device, label: d.label }); }}
        onRemove={(d) => { setErasePassword(undefined); setEraseDevice({ name: d.device, label: d.label }); }}
      />
      {eraseDevice && (
        <FormatDriveFlow
          device={eraseDevice}
          password={erasePassword}
          onCancel={closeErase}
          onDone={(driveId) => { closeErase(); navigate(`/files/${driveId}`); }}
        />
      )}
      <InspectModal
        open={inspectFor != null}
        drive={inspectFor}
        result={inspect.data}
        error={inspect.isError ? apiErrorMessage(inspect.error, "Luna couldn't look at this drive safely. Make sure it's plugged in and try again.") : null}
        onClose={() => { releaseInspectedDrive(inspectFor); setInspectFor(null); inspect.reset(); adopt.reset(); }}
        onAdopt={(label) => adopt.mutateAsync({ drive: inspectFor, label })}
        // The dev review drive isn't a real disk, so there is nothing to erase.
        onErase={isMockUnknownDrive(inspectFor?.name) ? undefined : async (d) => {
          // Looking at the drive takes its lock, so let go of the read-only look first.
          await releaseInspectedDrive(d);
          setInspectFor(null);
          inspect.reset();
          adopt.reset();
          setErasePassword(undefined);
          setEraseDevice({ name: d.name, model: d.model, label: d.model || "", format_id: d.format_id });
        }}
        // "Erase & Encrypt" collects the password before opening the erase window.
        onProtect={isMockUnknownDrive(inspectFor?.name) ? undefined : async (d, password) => {
          await releaseInspectedDrive(d);
          setInspectFor(null);
          inspect.reset();
          adopt.reset();
          setErasePassword(password);
          setEraseDevice({ name: d.name, model: d.model, label: d.model || "", format_id: d.format_id });
        }}
        onBeforeUnlock={() => releaseInspectedDrive(inspectFor)}
        adoptError={adoptError}
        adopting={adopt.isPending}
      />
    </Page>
  );
}

