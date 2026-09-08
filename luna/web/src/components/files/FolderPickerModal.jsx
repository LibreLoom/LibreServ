import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import Dropdown from "../common/Dropdown.jsx";
import ModalErrorNotice from "../common/ModalErrorNotice.jsx";
import FileBrowser from "./FileBrowser.jsx";
import CreateNameModal from "./CreateNameModal.jsx";
import NewItemMenu from "./NewItemMenu.jsx";
import { apiErrorMessage, postJson } from "../../lib/api.js";
import { parseCreateName } from "../../lib/createName.js";
import { joinPath } from "../../lib/paths.js";

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
  const activeDrives = useMemo(() => {
    return (drives || []).filter((d) => (
      d.state !== "missing"
      && d.state !== "ejected"
      && d.state !== "failed"
      && d.state !== "readonly"
    ));
  }, [drives]);

  const [driveId, setDriveId] = useState(initialDriveId);
  const [path, setPath] = useState(initialPath);
  const [picked, setPicked] = useState(initialPath);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState(/** @type {string|null} */ (null));
  const [createBusy, setCreateBusy] = useState(false);
  const drive = activeDrives.find((d) => d.id === driveId) || activeDrives[0] || drives[0];

  useEffect(() => {
    if (!open) return;
    const nextId = activeDrives.some((d) => d.id === initialDriveId)
      ? initialDriveId
      : (activeDrives[0]?.id || initialDriveId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- props/open seed draft UI state
    setDriveId(nextId);
    const keepPath = nextId === initialDriveId;
    setPath(keepPath ? initialPath : "");
    setPicked(keepPath ? initialPath : "");
    setCreating(false);
    setCreateError(null);
  }, [open, initialDriveId, initialPath, activeDrives]);

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
      await postJson(`/api/v1/drives/${drive.id}/files/mkdir`, { path: fullPath });
      await queryClient.invalidateQueries({ queryKey: ["files", drive.id, path] });
    } catch (err) {
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
          {activeDrives.length > 1 && (
            <div className="mb-3">
              <label className="block text-primary text-xs mb-1.5 font-mono uppercase tracking-wider">
                Destination drive
              </label>
              {activeDrives.length <= 4 ? (
                <div className="flex flex-wrap gap-2">
                  {activeDrives.map((d) => {
                    const isSelected = d.id === driveId;
                    return (
                      <Button
                        key={d.id}
                        type="button"
                        variant={isSelected ? "primary" : "outline"}
                        surface="secondary"
                        size="sm"
                        aria-label={d.id === initialDriveId ? `${d.label} (current)` : d.label}
                        onClick={() => {
                          setDriveId(d.id);
                          setPath("");
                          setPicked("");
                        }}
                      >
                        <HardDrive size={14} className="mr-1.5 shrink-0" aria-hidden="true" />
                        <span>{d.label}</span>
                        {d.id === initialDriveId ? (
                          <span className="text-xs font-mono ml-1">(current)</span>
                        ) : null}
                      </Button>
                    );
                  })}
                </div>
              ) : (
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
              )}
            </div>
          )}

          {drive ? (
            <FileBrowser
              driveId={drive.id}
              driveLabel={drive.label}
              path={path}
              onPathChange={setPath}
              pickerMode="folder"
              selectedPath={picked}
              onSelect={(ctx) => setPicked(ctx.fullPath)}
              multiSelect={false}
              enableDownload={false}
              enableUploadDrop={false}
              dense
              folderActions={<NewItemMenu ids={["folder"]} onPick={openCreateFolder} />}
              emptyAction={(
                <div className="flex justify-center">
                  <NewItemMenu ids={["folder"]} onPick={openCreateFolder} />
                </div>
              )}
            />
          ) : (
            <p className="text-primary text-sm">No drives available. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in.</p>
          )}

          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              variant="primary"
              surface="secondary"
              loading={busy}
              disabled={!drive}
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
