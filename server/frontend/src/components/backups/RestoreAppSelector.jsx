import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import PropTypes from "prop-types";

function RestoreAppSelector({ backup, apps, onRestore, onClose }) {
  const [selectedAppId, setSelectedAppId] = useState("");
  const [restoring, setRestoring] = useState(false);

  const selectedApp = apps.find((a) => a.id === selectedAppId);

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

  return (
    <div className="fixed inset-0 bg-primary/20 flex items-center justify-center z-50">
      <div className="bg-secondary rounded-[24px] p-6 max-w-md w-full mx-4 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-mono text-xl text-primary">Select Target App</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-primary/10 text-primary/40 hover:text-primary/60"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-primary/60 mb-4">
          This backup is not linked to an installed app. Choose where to restore
          it.
        </p>

        <select
          value={selectedAppId}
          onChange={(e) => setSelectedAppId(e.target.value)}
          className="w-full rounded-[12px] border border-primary/20 bg-secondary px-4 py-3 text-primary mb-4 focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="">Select an app...</option>
          {apps.map((app) => (
            <option key={app.id} value={app.id}>
              {app.name || app.id}
            </option>
          ))}
        </select>

        {selectedApp && (
          <div className="flex items-start gap-2 p-3 rounded-[12px] bg-warning/10 border border-warning/20 mb-4">
            <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
            <p className="text-sm text-primary/70">
              This will replace all data in{" "}
              <strong>{selectedApp.name || selectedApp.id}</strong>.
            </p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 rounded-pill border border-primary/20 text-primary hover:bg-primary/5 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRestore}
            disabled={!selectedAppId || restoring}
            className="flex-1 py-3 rounded-pill bg-primary text-secondary hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {restoring ? "Restoring..." : "Restore"}
          </button>
        </div>
      </div>
    </div>
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

export default RestoreAppSelector;
