import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../../../hooks/useAuth";
import {
  Cloud,
  HardDrive,
  Plus,
  Loader2,
  DatabaseBackup,
  Download,
  Trash2,
  Upload,
  AlertTriangle,
  CheckCircle,
  X,
} from "lucide-react";
import CloudBackupConfig from "../../backups/CloudBackupConfig";
import Card from "../../common/cards/Card";

function formatDate(dateStr) {
	if (!dateStr) return "-";
	const date = new Date(dateStr);
	return date.toLocaleDateString() + " " + date.toLocaleTimeString();
}

function formatBytes(bytes) {
	if (!bytes || bytes === 0) return "-";
	const units = ["B", "KB", "MB", "GB"];
	let unitIndex = 0;
	let value = bytes;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export default function BackupsCategory() {
  const { request } = useAuth();
  const [backups, setBackups] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [showCloudConfig, setShowCloudConfig] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(null);
  const [selectedApp, setSelectedApp] = useState("");
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(null);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearNotifications = useCallback(() => {
    setError(null);
    setSuccess(null);
  }, []);

  const showSuccess = useCallback((message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(null), 5000);
  }, []);

  async function loadData() {
    setLoading(true);
    setLoadError(null);
    try {
      const [backupsRes, appsRes] = await Promise.all([
        request("/backups"),
        request("/apps"),
      ]);

      if (!backupsRes.ok) {
        const err = await backupsRes.json();
        throw new Error(err.error || "Failed to load backups");
      }
      if (!appsRes.ok) {
        const err = await appsRes.json();
        throw new Error(err.error || "Failed to load apps");
      }

      const backupsData = await backupsRes.json();
      const appsData = await appsRes.json();
      setBackups(backupsData.backups || []);
      setApps(appsData.apps || []);
    } catch (err) {
      console.error("Failed to load data:", err);
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }

async function handleCreateBackup() {
    if (!selectedApp) return;
    setCreating(true);
    clearNotifications();

    try {
      const res = await request("/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: selectedApp,
          stop_before_backup: false,
          compress: true,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create backup");
      }

      setShowCreateModal(false);
      setSelectedApp("");
      showSuccess("Backup created successfully");
      loadData();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleRestoreBackup() {
    if (!showRestoreModal) return;
    setRestoring(true);
    clearNotifications();

    try {
      const res = await request(
        `/backups/${showRestoreModal.id}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stop_before_restore: true,
            restart_after_restore: true,
            verify_checksum: true,
          }),
        }
      );

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to restore backup");
      }

      setShowRestoreModal(null);
      showSuccess("Backup restored successfully");
      loadData();
    } catch (err) {
      setError(err.message);
    } finally {
      setRestoring(false);
    }
  }

  async function handleDeleteBackup() {
    if (!showDeleteModal) return;
    setDeleting(true);
    clearNotifications();

    try {
      const res = await request(`/backups/${showDeleteModal.id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to delete backup");
      }

      setShowDeleteModal(null);
      showSuccess("Backup deleted successfully");
      loadData();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  async function handleUploadToCloud(backup) {
    setUploading(backup.id);
    clearNotifications();

    try {
      const res = await request(`/backups/${backup.id}/upload`, {
        method: "POST",
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to upload to cloud");
      }

      showSuccess("Backup uploaded to cloud successfully");
      loadData();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(null);
    }
  }

  function getAppDisplayName(backup) {
    const app = apps.find((a) => a.id === backup.app_id);
    return app?.name || backup.app_id || "System";
  }

	const recentBackups = backups.slice(0, 5);

return (
    <div className="space-y-4">
      {/* Success Message */}
      {success && (
        <div className="bg-accent/10 border border-accent/30 rounded-card p-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-accent" />
            <p className="font-mono text-sm text-accent">{success}</p>
          </div>
          <button onClick={() => setSuccess(null)} className="text-accent/50 hover:text-accent">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-card p-3 flex items-center justify-between">
          <p className="font-mono text-sm text-red-500">{error}</p>
          <button onClick={() => setError(null)} className="text-red-500/50 hover:text-red-500">
            <X size={16} />
          </button>
        </div>
      )}

			{/* Local Backups Section */}
			<div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
				<div className="flex items-center justify-between px-4 py-3 border-b border-primary/10">
					<div className="flex items-center gap-2">
						<HardDrive size={18} className="text-accent" />
						<h2 className="font-mono font-normal text-primary">Local Backups</h2>
					</div>
					<button
						onClick={() => setShowCreateModal(true)}
						className="flex items-center gap-1 text-xs text-accent hover:text-secondary transition-colors"
					>
						<Plus size={14} />
						Create
					</button>
				</div>

{loading ? (
        <div className="px-4 py-6 flex justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-accent" />
        </div>
      ) : loadError ? (
        <div className="px-4 py-6 text-center">
          <AlertTriangle className="w-10 h-10 text-red-500 mx-auto mb-2" />
          <p className="text-sm text-red-500 mb-3">{loadError}</p>
          <button
            onClick={loadData}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-pill bg-primary/10 text-primary hover:bg-primary/20 transition-all font-mono text-sm"
          >
            Retry
          </button>
        </div>
      ) : recentBackups.length === 0 ? (
					<div className="px-4 py-6 text-center">
						<DatabaseBackup className="w-10 h-10 text-primary/30 mx-auto mb-2" />
						<p className="text-sm text-accent">No backups yet</p>
						<button
							onClick={() => setShowCreateModal(true)}
							className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:outline-accent hover:ring-2 transition-all font-mono text-sm"
						>
							<Plus size={16} />
							Create Backup
						</button>
					</div>
				) : (
					<div className="divide-y divide-primary/10">
{recentBackups.map((backup) => {
        const app = apps.find((a) => a.id === backup.app_id);
        const isUploading = uploading === backup.id;
        return (
          <div key={backup.id} className="px-4 py-3 flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <div className="font-mono text-sm text-primary truncate">
                {getAppDisplayName(backup)}
              </div>
              <div className="text-xs text-accent mt-0.5 flex items-center gap-2">
                <span>{formatDate(backup.created_at)}</span>
                <span>·</span>
                <span>{formatBytes(backup.size)}</span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {backup.cloud_status?.has_cloud_copy ? (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-accent/20 text-accent text-xs mr-2">
                  <Cloud size={12} />
                  Cloud
                </span>
              ) : (
                <button
                  onClick={() => handleUploadToCloud(backup)}
                  disabled={isUploading}
                  className={`p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all mr-1 ${isUploading ? "opacity-50 cursor-wait" : ""}`}
                  title="Upload to Cloud"
                >
                  {isUploading ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Upload size={14} />
                  )}
                </button>
              )}
              <button
                onClick={() => setShowRestoreModal(backup)}
                className="p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                title="Restore"
              >
                <Download size={14} />
              </button>
              <button
                onClick={() => setShowDeleteModal(backup)}
                className="p-1.5 rounded-pill hover:bg-red-500/10 text-accent/50 hover:text-red-500 transition-all"
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        );
      })}
					</div>
				)}

				{backups.length > 5 && (
					<div className="px-4 py-2 border-t border-primary/10 text-center">
						<span className="text-xs text-accent">
							{backups.length - 5} more backup{backups.length - 5 !== 1 ? "s" : ""}
						</span>
					</div>
				)}
			</div>

{/* Cloud Backup Section */}
      <div 
        className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300"
        style={{ animationDelay: "50ms" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/10">
          <div className="flex items-center gap-2">
            <Cloud size={18} className="text-accent" />
            <h2 className="font-mono font-normal text-primary">Cloud Backup</h2>
          </div>
          <button
            onClick={() => setShowCloudConfig(!showCloudConfig)}
            className="text-xs text-accent hover:text-secondary transition-colors"
          >
            {showCloudConfig ? "Hide" : "Configure"}
          </button>
        </div>

        {showCloudConfig ? (
          <div className="p-4">
            <CloudBackupConfig onConfigured={() => setShowCloudConfig(false)} />
          </div>
        ) : (
          <div className="px-4 py-6 text-center">
            <Cloud className="w-8 h-8 text-primary/30 mx-auto mb-2" />
            <p className="text-sm text-accent">
              Configure cloud backup for off-site storage
            </p>
            <button
              onClick={() => setShowCloudConfig(true)}
              className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:outline-accent hover:ring-2 transition-all font-mono text-sm"
            >
              Configure Cloud Backup
            </button>
          </div>
        )}
      </div>

{/* Create Backup Modal */}
      {showCreateModal && (
        <div 
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowCreateModal(false);
              setSelectedApp("");
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setShowCreateModal(false);
              setSelectedApp("");
            }
          }}
          tabIndex={-1}
        >
          <Card className="w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-mono text-lg text-primary mb-4">Create Backup</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-mono text-primary/70 mb-2">
                  Select App
                </label>
                <select
                  value={selectedApp}
                  onChange={(e) => setSelectedApp(e.target.value)}
                  className="w-full px-3 py-2 bg-primary/10 border border-primary/20 rounded-pill font-mono text-sm text-primary focus:outline-none focus:border-accent"
                >
                  <option value="">Select an app...</option>
                  {apps.map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setSelectedApp("");
                }}
                className="flex-1 px-4 py-2 rounded-pill bg-primary/10 text-primary hover:bg-primary/20 transition-all font-mono text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateBackup}
                disabled={!selectedApp || creating}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:outline-accent hover:ring-2 transition-all font-mono text-sm disabled:opacity-50"
              >
                {creating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <DatabaseBackup className="w-4 h-4" />
                )}
                Create
              </button>
            </div>
          </Card>
        </div>
      )}

{/* Restore Confirmation Modal */}
      {showRestoreModal && (
        <div 
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowRestoreModal(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setShowRestoreModal(null);
            }
          }}
          tabIndex={-1}
        >
          <Card className="w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-6 h-6 text-yellow-500 mt-0.5" />
              <div>
                <h2 className="font-mono text-lg text-primary">Restore Backup</h2>
                <p className="font-mono text-sm text-primary/70 mt-1">
                  This will replace the current data for{" "}
                  <strong>{getAppDisplayName(showRestoreModal)}</strong>.
                </p>
              </div>
            </div>
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-card p-3 mb-4">
              <p className="font-mono text-xs text-yellow-500">
                Warning: Current data will be overwritten. This action cannot be undone.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowRestoreModal(null)}
                className="flex-1 px-4 py-2 rounded-pill bg-primary/10 text-primary hover:bg-primary/20 transition-all font-mono text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleRestoreBackup}
                disabled={restoring}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-yellow-500 text-primary hover:outline-yellow-500 hover:ring-2 transition-all font-mono text-sm"
              >
                {restoring ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                Restore
              </button>
            </div>
          </Card>
        </div>
      )}

			{/* Delete Confirmation Modal */}
			{showDeleteModal && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
					<Card className="w-full max-w-md p-6">
						<div className="flex items-start gap-3 mb-4">
							<AlertTriangle className="w-6 h-6 text-red-500 mt-0.5" />
							<div>
								<h2 className="font-mono text-lg text-primary">Delete Backup</h2>
								<p className="font-mono text-sm text-primary/70 mt-1">
									This backup will be permanently deleted.
								</p>
							</div>
						</div>
						<div className="bg-red-500/10 border border-red-500/30 rounded-card p-3 mb-4">
							<p className="font-mono text-xs text-red-500">
								This action cannot be undone. The backup file will be removed from disk.
							</p>
						</div>
						<div className="flex gap-3">
							<button
								onClick={() => setShowDeleteModal(null)}
								className="flex-1 px-4 py-2 rounded-pill bg-primary/10 text-primary hover:bg-primary/20 transition-all font-mono text-sm"
							>
								Cancel
							</button>
							<button
								onClick={handleDeleteBackup}
								disabled={deleting}
								className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-red-500 text-primary hover:outline-red-500 hover:ring-2 transition-all font-mono text-sm"
							>
								{deleting ? (
									<Loader2 className="w-4 h-4 animate-spin" />
								) : (
									<Trash2 className="w-4 h-4" />
								)}
								Delete
							</button>
						</div>
					</Card>
				</div>
			)}
		</div>
	);
}
