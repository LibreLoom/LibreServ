import { useState } from "react";
import { AlertTriangle, Upload } from "lucide-react";
import PropTypes from "prop-types";
import ConfirmModal from "../common/ConfirmModal";

export default function RestoreAppSelector({ backup, apps, onRestore, onClose }) {
  const [selectedAppId, setSelectedAppId] = useState("");
  const [restoring, setRestoring] = useState(false);

  async function handleRestore() {
    if (!selectedAppId) return;
    setRestoring(true);
    try {
      await onRestore(backup.id, selectedAppId);
      onClose();
    } finally {
      setRestoring(false);
    }
  }

  const selectedApp = apps.find((a) => a.id === selectedAppId);

  return (
    <ConfirmModal
      open={true}
      onClose={onClose}
      onConfirm={handleRestore}
      icon={AlertTriangle}
      title="Select Target App"
      message="This backup is not linked to an installed app. Choose where to restore it."
      variant="warning"
      confirmLabel="Restore"
      confirmIcon={Upload}
      loading={restoring}
    >
      <div className="mt-3">
        <select
          value={selectedAppId}
          onChange={(e) => setSelectedAppId(e.target.value)}
          className="w-full px-3 py-2 bg-primary/10 border border-primary/20 rounded-pill font-mono text-sm text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          <option value="">Select an app...</option>
          {apps.map((app) => (
            <option key={app.id} value={app.id}>
              {app.name || app.id}
            </option>
          ))}
        </select>

        {selectedApp && (
          <div className="mt-3 flex items-start gap-2 p-3 rounded-large-element bg-warning/10 border border-warning/20">
            <AlertTriangle size={14} className="text-warning flex-shrink-0 mt-0.5" />
            <p className="text-xs text-primary/70">
              This will replace all data in <strong>{selectedApp.name || selectedApp.id}</strong>.
            </p>
          </div>
        )}
      </div>
    </ConfirmModal>
  );
}

RestoreAppSelector.propTypes = {
  backup: PropTypes.shape({
    id: PropTypes.string.isRequired,
  }).isRequired,
  apps: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string,
    })
  ).isRequired,
  onRestore: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
