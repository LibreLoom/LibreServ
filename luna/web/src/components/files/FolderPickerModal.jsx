import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import ModalErrorNotice from "@libreloom/ui/components/common/ModalErrorNotice.jsx";
import FileBrowser from "./FileBrowser.jsx";
import CreateNameModal from "./CreateNameModal.jsx";
import NewItemMenu from "./NewItemMenu.jsx";
import { apiErrorMessage, getDrives, getJson } from "../../lib/api.js";
import { fileListKey, useFileSource } from "../../lib/fileSource.jsx";
import { parseCreateName } from "../../lib/createName.js";
import { isMemberHomePath, isTrashPath, joinPath } from "../../lib/paths.js";
import { isPresentDrive, isWritableDrive } from "../../lib/drives.js";
import { CAP } from "../../lib/access.js";
import { memberCapsAt, memberWritableRoots, pathContains } from "../../lib/shareTree.js";
import { useOptionalAuth } from "../../context/AuthContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";

/**
 * Pick a destination folder on a drive — replaces typed path fields.
 *
 * @param {{
 *   title?: string,
 *   drives: Array<{ id: string, label: string, state?: string }>,
 *   initialDriveId: string,
 *   initialPath?: string,
 *   confirmLabel?: string,
 *   onConfirm: (dest: { driveId: string, path: string }, close: () => void) => void,
 *   onClose: () => void,
 *   open?: boolean,
 *   busy?: boolean,
 *   error?: string | null,
 * }} props
 */
export default function FolderPickerModal({
  title = "Choose a folder",
  drives,
  initialDriveId,
  initialPath = "",
  confirmLabel = "Use this folder",
  onConfirm,
  onClose,
  open = true,
  busy = false,
  error = null,
}) {
  const queryClient = useQueryClient();
  const source = useFileSource();
  const { addToast } = useToast();
  const activeDrives = useMemo(() => {
    return (drives || []).filter((d) => (
      d.state !== "missing"
      && d.state !== "ejected"
      && d.state !== "failed"
      && d.state !== "readonly"
    ));
  }, [drives]);

  // Signed-in people pick from writable roots — My files plus every shared
  // folder they can put files in (for Admins, each drive's top level).
  // Guests keep whole drives (the caller already scoped `drives`).
  const user = useOptionalAuth()?.user;
  const rooted = Boolean(user);
  const isAdmin = user?.role === "admin";
  const access = useQuery({
    queryKey: ["my-access"],
    queryFn: () => getJson("/api/v1/me/access"),
    enabled: open && rooted && !isAdmin,
  });
  // Destinations live on every present drive — not just the subset
  // the caller passed (an admin-shaped `drives` prop can omit the person's
  // home drive entirely).
  const drivesQuery = useQuery({
    queryKey: ["drives"],
    queryFn: getDrives,
    enabled: open && rooted,
  });
  const memberDrives = useMemo(() => (
    rooted
      ? (drivesQuery.data || []).filter(isPresentDrive)
      : []
  ), [rooted, drivesQuery.data]);
  const roots = useMemo(() => {
    if (!rooted || !(isAdmin ? drivesQuery.data : access.data)) return null;
    const present = new Set(memberDrives.map((d) => d.id));
    const labelOf = (id) => memberDrives.find((d) => d.id === id)?.label || id;
    const own = memberWritableRoots([], user?.home, (id) => present.has(id), labelOf);
    if (!isAdmin) return memberWritableRoots(access.data, user?.home, (id) => present.has(id), labelOf);
    return [
      ...own,
      ...memberDrives
        .filter((d) => isWritableDrive(d))
        .map((d) => ({ driveId: d.id, path: "", label: d.label, isHome: false })),
    ];
  }, [rooted, isAdmin, access.data, drivesQuery.data, user?.home, memberDrives]);
  const [rootIdx, setRootIdx] = useState(0);
  const root = rooted ? (roots?.[rootIdx] || roots?.[0] || null) : null;

  const [driveId, setDriveId] = useState(initialDriveId);
  const [path, setPath] = useState(initialPath);
  const [picked, setPicked] = useState(initialPath);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState(/** @type {string|null} */ (null));
  const [createBusy, setCreateBusy] = useState(false);
  const browseDriveId = rooted ? (root?.driveId || "") : driveId;
  const drive = rooted
    ? (memberDrives.find((d) => d.id === browseDriveId) || null)
    : (activeDrives.find((d) => d.id === browseDriveId) || activeDrives[0] || drives[0]);

  /** Capability bits for `p` on the browsed drive (member mode only). */
  const capsAt = (p) => (isAdmin
    ? CAP.VIEW | CAP.UPLOAD | CAP.EDIT | CAP.SHARE
    : memberCapsAt(access.data, browseDriveId, p, user?.home));
  const canWriteAt = (p) => (capsAt(p) & (CAP.UPLOAD | CAP.EDIT)) !== 0;

  useEffect(() => {
    if (!open) return;
    if (rooted) {
      // Seed on the writable root containing the initial path — usually
      // Home — or the first root. An unwritable origin folder is never a
      // destination, so nothing below it is pre-picked.
      if (!roots) return;
      const idx = roots.findIndex((r) => (
        r.driveId === initialDriveId
        && (r.path === "" || pathContains(r.path, initialPath))
      ));
      const next = roots[idx >= 0 ? idx : 0];
      // eslint-disable-next-line react-hooks/set-state-in-effect -- open resets the selected root
      setRootIdx(idx >= 0 ? idx : 0);
      const seed = idx >= 0 ? initialPath : (next?.path || "");
      setPath(seed);
      setPicked(seed);
      setCreating(false);
      setCreateError(null);
      return;
    }
    const nextId = activeDrives.some((d) => d.id === initialDriveId)
      ? initialDriveId
      : (activeDrives[0]?.id || initialDriveId);
    setDriveId(nextId);
    const keepPath = nextId === initialDriveId;
    setPath(keepPath ? initialPath : "");
    setPicked(keepPath ? initialPath : "");
    setCreating(false);
    setCreateError(null);
  }, [open, initialDriveId, initialPath, activeDrives, rooted, roots]);

  async function submitCreateFolder() {
    const parsed = parseCreateName(createName);
    if (parsed.error) {
      setCreateError(parsed.error);
      throw new Error(parsed.error);
    }
    if (!drive) {
      setCreateError("Choose a drive first.");
      throw new Error("no drive");
    }
    setCreateBusy(true);
    setCreateError(null);
    try {
      const fullPath = joinPath(path, parsed.name);
      await source.mkdir(drive.id, fullPath);
      await queryClient.invalidateQueries({ queryKey: fileListKey(source, drive.id, path) });
      addToast({ type: "success", message: "Folder created." });
    } catch (err) {
      haptic("error");
      setCreateError(apiErrorMessage(err, "Couldn't create that folder. Try another name."));
      throw err;
    } finally {
      setCreateBusy(false);
    }
  }

  function openCreateFolder() {
    setCreateError(null);
    setCreateName("");
    setCreating(true);
  }

  return (
    <ModalCard open={open} title={title} size="lg" onClose={onClose}>
      {({ close }) => (
        <>
          <ModalErrorNotice error={error} className="mb-3" />
          {rooted ? (
            roots === null ? (
              <p className="text-primary text-sm mb-3">Loading your folders…</p>
            ) : roots.length === 0 ? (
              <p className="text-primary text-sm mb-3">
                You don't have anywhere to put files yet. Ask an admin to share a folder with you.
              </p>
            ) : roots.length > 1 ? (
              <div className="mb-3">
                <label className="block text-primary text-xs mb-1.5 font-mono uppercase tracking-wider">
                  Destination
                </label>
                <Dropdown
                  options={roots.map((r, i) => ({
                    value: String(i),
                    label: `${r.label}${r.driveId === initialDriveId && r.path === initialPath ? " (current)" : ""}`,
                  }))}
                  value={String(roots.indexOf(root))}
                  onChange={(v) => {
                    const next = roots[Number(v)];
                    if (!next) return;
                    setRootIdx(Number(v));
                    setPath(next.path);
                    setPicked(next.path);
                  }}
                  fullWidth
                  bg="primary"
                />
              </div>
            ) : null
          ) : activeDrives.length > 1 && (
            <div className="mb-3">
              <label className="block text-primary text-xs mb-1.5 font-mono uppercase tracking-wider">
                Destination drive
              </label>
              <Dropdown
                options={activeDrives.map((d) => ({
                  value: d.id,
                  label: `${d.label}${d.id === initialDriveId ? " (current)" : ""}`,
                }))}
                value={driveId}
                onChange={(id) => {
                  setDriveId(id);
                  setPath("");
                  setPicked("");
                }}
                fullWidth
                bg="primary"
              />
            </div>
          )}

          {drive && (!rooted || root) ? (
            <FileBrowser
              driveId={drive.id}
              driveLabel={drive.label}
              path={path}
              pathFloor={rooted ? (root?.path || "") : ""}
              forbiddenState={rooted ? (
                <p className="text-secondary text-sm">
                  You can add files here, but this folder can't be opened.
                </p>
              ) : null}
              segmentLabel={rooted ? (segment, i) =>
                (i === 1 && isMemberHomePath(path) ? "My files" : segment) : undefined}
              onPathChange={setPath}
              pickerMode="folder"
              selectedPath={picked}
              onSelect={(ctx) => setPicked(ctx.fullPath)}
              multiSelect={false}
              enableDownload={false}
              enableUploadDrop={false}
              dense
              surface="primary"
              folderActions={isTrashPath(path) || (rooted && !canWriteAt(path)) ? null
                : <NewItemMenu ids={["folder"]} onPick={openCreateFolder} surface="primary" />}
            />
          ) : rooted && roots && roots.length === 0 ? null : (
            <p className="text-primary text-sm">No drives available. Make sure your drive is plugged in — if it already is, try unplugging it and plugging it back in.</p>
          )}

          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              variant="primary"
              surface="secondary"
              loading={busy}
              disabled={!drive || isTrashPath(picked)
                || (rooted && (!root || !canWriteAt(picked)))}
              onClick={() => onConfirm({ driveId: drive.id, path: picked }, close)}
            >
              {confirmLabel}
            </Button>
            <Button variant="outline" surface="secondary" onClick={close}>
              Cancel
            </Button>
          </div>

          <CreateNameModal
            open={creating}
            title="New folder"
            label="Name for this folder"
            placeholder="e.g. Holiday photos"
            hint="Luna will put it in the folder you are in now."
            value={createName}
            onChange={setCreateName}
            confirmLabel="Create folder"
            busy={createBusy}
            error={createError}
            onSubmit={submitCreateFolder}
            onClose={() => {
              setCreateError(null);
              setCreating(false);
            }}
          />
        </>
      )}
    </ModalCard>
  );
}

FolderPickerModal.propTypes = {
  title: PropTypes.string,
  drives: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
  })).isRequired,
  initialDriveId: PropTypes.string.isRequired,
  initialPath: PropTypes.string,
  confirmLabel: PropTypes.string,
  onConfirm: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  open: PropTypes.bool,
  busy: PropTypes.bool,
  error: PropTypes.string,
};
