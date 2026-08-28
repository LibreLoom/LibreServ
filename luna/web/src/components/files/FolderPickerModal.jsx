import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import Dropdown from "../common/Dropdown.jsx";
import FileBrowser from "./FileBrowser.jsx";

/**
 * Pick a destination folder on a drive — replaces typed path fields.
 *
 * @param {{
 *   title?: string,
 *   drives: Array<{ id: string, label: string }>,
 *   initialDriveId: string,
 *   initialPath?: string,
 *   confirmLabel?: string,
 *   onConfirm: (dest: { driveId: string, path: string }, close: () => void) => void,
 *   onClose: () => void,
 *   open?: boolean,
 *   busy?: boolean,
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
}) {
  const [driveId, setDriveId] = useState(initialDriveId);
  const [path, setPath] = useState(initialPath);
  const [picked, setPicked] = useState(initialPath);
  const drive = drives.find((d) => d.id === driveId) || drives[0];

  useEffect(() => {
    if (!open) return;
    setDriveId(initialDriveId);
    setPath(initialPath);
    setPicked(initialPath);
  }, [open, initialDriveId, initialPath]);

  return (
    <ModalCard open={open} title={title} size="lg" onClose={onClose}>
      {({ close }) => (
        <>
          {drives.length > 1 && (
            <div className="mb-3">
              <label className="block text-primary text-xs mb-1">Which drive?</label>
              <Dropdown
                options={drives.map((d) => ({ value: d.id, label: d.label }))}
                value={driveId}
                onChange={(id) => {
                  setDriveId(id);
                  setPath("");
                  setPicked("");
                }}
                fullWidth
              />
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
            />
          ) : (
            <p className="text-primary text-sm">No drives available.</p>
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
};
