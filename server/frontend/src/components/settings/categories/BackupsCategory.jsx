import { useState, useEffect, useCallback, useRef } from "react";
import { useAnimatedHeight } from "../../../hooks/useAnimatedHeight";
import { useAuth } from "../../../hooks/useAuth";
import { goeyToast } from "goey-toast";
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
  Save,
} from "lucide-react";
import CloudBackupConfig from "../../backups/CloudBackupConfig";
import ScheduleForm from "../../backups/ScheduleForm";
import UploadProgress from "../../backups/UploadProgress";
import RestoreAppSelector from "../../backups/RestoreAppSelector";
import InfoPopover from "../../common/InfoPopover";
import Card from "../../common/cards/Card";

function formatDate(dateStr) {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return (
    date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }) +
    " " +
    date.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
  );
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
  const [unattachedBackups, setUnattachedBackups] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [showCloudConfig, setShowCloudConfig] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(null);
  const [showAppSelector, setShowAppSelector] = useState(null);
  const [selectedApp, setSelectedApp] = useState("");
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(null);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadingDb, setUploadingDb] = useState(false);
  const [savingDb, setSavingDb] = useState(false);
  const fileInputRef = useRef(null);
  const dbFileInputRef = useRef(null);
  const localCard = useAnimatedHeight();
  const uploadCard = useAnimatedHeight();
  const databaseCard = useAnimatedHeight();
  const cloudCard = useAnimatedHeight();

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showSuccess = useCallback((message, description) => {
    goeyToast.success(message, {
      description,
      timing: { displayDuration: 3000 },
    });
  }, []);

  const showError = useCallback((message, description) => {
    goeyToast.error(message, {
      description,
    });
  }, []);

  async function loadData() {
    setLoading(true);
    setLoadError(null);
    try {
      const [backupsRes, appsRes, unattachedRes] = await Promise.all([
        request("/backups"),
        request("/apps"),
        request("/backups/unattached"),
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
      const unattachedData = unattachedRes.ok ? await unattachedRes.json() : { backups: [] };
      setBackups(backupsData.backups || []);
      setApps(appsData.apps || []);
      setUnattachedBackups(unattachedData.backups || []);
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
      showSuccess("Backup created", "Your backup has been created successfully.");
      loadData();
    } catch (err) {
      showError("Failed to create backup", err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleRestoreBackup() {
    if (!showRestoreModal) return;
    setRestoring(true);

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
      showSuccess("Backup restored", "Your data has been restored successfully.");
      loadData();
    } catch (err) {
      showError("Failed to restore backup", err.message);
    } finally {
      setRestoring(false);
    }
  }

  async function handleDeleteBackup() {
    if (!showDeleteModal) return;
    setDeleting(true);

    try {
      const res = await request(`/backups/${showDeleteModal.id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to delete backup");
      }

      setShowDeleteModal(null);
      showSuccess("Backup deleted", "The backup has been removed.");
      loadData();
    } catch (err) {
      showError("Failed to delete backup", err.message);
    } finally {
      setDeleting(false);
    }
  }

  async function handleUploadToCloud(backup) {
    setUploading(backup.id);

    try {
      const res = await request(`/backups/${backup.id}/upload`, {
        method: "POST",
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to upload to cloud");
      }

      showSuccess("Upload complete", "Backup has been uploaded to cloud storage.");
      loadData();
    } catch (err) {
      showError("Upload failed", err.message);
    } finally {
      setUploading(null);
    }
  }

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.toLowerCase();
    if (!ext.endsWith(".tar") && !ext.endsWith(".tar.gz") && !ext.endsWith(".tgz")) {
      showError("Invalid file", "Only .tar, .tar.gz, and .tgz files are supported.");
      return;
    }

    setUploadFile(file);
  }

  function handleUploadComplete() {
    setUploadFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    showSuccess("Backup uploaded", "Your backup has been uploaded successfully.");
    loadData();
  }

  function handleUploadError(err) {
    showError("Upload failed", err.message);
  }

  async function handleRestoreUnattachedBackup(backupId, targetAppId) {
    setRestoring(true);

    try {
      const res = await request(`/backups/${backupId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_app_id: targetAppId,
          stop_before_restore: true,
          restart_after_restore: true,
          verify_checksum: true,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to restore backup");
      }

      setShowAppSelector(null);
      showSuccess("Backup restored", "Your data has been restored successfully.");
      loadData();
    } catch (err) {
      showError("Failed to restore backup", err.message);
    } finally {
      setRestoring(false);
    }
  }

  async function handleSaveDatabase() {
    setSavingDb(true);

    try {
      const res = await request("/backups/database", {
        method: "POST",
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to save database");
      }

      showSuccess("Database saved", "Database backup created successfully.");
    } catch (err) {
      showError("Failed to save database", err.message);
    } finally {
      setSavingDb(false);
    }
  }

  function handleDbFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.toLowerCase();
    if (!ext.endsWith(".gz") && !ext.endsWith(".db")) {
      showError("Invalid file", "Only .gz and .db files are supported.");
      return;
    }

    uploadAndRestoreDatabase(file);
  }

  async function uploadAndRestoreDatabase(file) {
    setUploadingDb(true);

    try {
      const formData = new FormData();
      formData.append("backup", file);

      const res = await fetch("/api/v1/backups/database/upload-restore", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to upload database backup");
      }

      showSuccess("Database restored", "Database has been restored. The page will refresh.");
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      showError("Failed to restore database", err.message);
    } finally {
      setUploadingDb(false);
      if (dbFileInputRef.current) {
        dbFileInputRef.current.value = "";
      }
    }
  }

  function getAppDisplayName(backup) {
    const app = apps.find((a) => a.id === backup.app_id);
    return app?.name || backup.app_id || "System";
  }

  const recentBackups = backups.slice(0, 5);

  return (
    <div className="space-y-4">
      {/* Local Backups Section */}
      <div
        ref={localCard.outerRef}
        className="bg-secondary rounded-large-element overflow-hidden transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
        style={{ transitionDuration: "var(--motion-duration-medium2)" }}
      >
        <div ref={localCard.innerRef}>
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

        <div
          key={loading ? "loading" : loadError ? "error" : recentBackups.length === 0 ? "empty" : "list"}
          className="animate-in fade-in slide-in-from-bottom-2"
          style={{ animationDuration: "var(--motion-duration-medium2)" }}
        >
        {loading ? (
          <div className="px-4 py-6 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-accent" />
          </div>
        ) : loadError ? (
          <div className="px-4 py-6 text-center">
            <AlertTriangle className="w-10 h-10 text-error mx-auto mb-2" />
            <p className="text-sm text-error mb-3">{loadError}</p>
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
               className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-2 transition-all font-mono text-sm"
             >
               <Plus size={16} />
               Create Backup
             </button>
          </div>
        ) : (
          <div className="divide-y divide-primary/10">
            {recentBackups.map((backup) => {
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
                    <a
                      href={`/api/v1/backups/${backup.id}/download`}
                      download
                      className="p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                      title="Download"
                    >
                      <Download size={14} />
                    </a>
                    <button
                      onClick={() => setShowRestoreModal(backup)}
                      className="p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                      title="Restore"
                    >
                      <Upload size={14} />
                    </button>
                    <button
                      onClick={() => setShowDeleteModal(backup)}
                      className="p-1.5 rounded-pill hover:bg-error/10 text-accent/50 hover:text-error transition-all"
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
        </div>
      </div>

      {/* Upload Backup Section */}
      <div
        ref={uploadCard.outerRef}
        className="bg-secondary rounded-large-element overflow-hidden transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
        style={{ transitionDuration: "var(--motion-duration-medium2)" }}
      >
        <div ref={uploadCard.innerRef}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <Upload size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary">Upload Backup</h2>
        </div>

        <div
          key={uploadFile ? "uploading" : "idle"}
          className="animate-in fade-in slide-in-from-bottom-2 p-4"
          style={{ animationDuration: "var(--motion-duration-medium2)" }}
        >
          {uploadFile ? (
            <UploadProgress
              file={uploadFile}
              onComplete={handleUploadComplete}
              onError={handleUploadError}
            />
          ) : (
            <label className="flex flex-col items-center justify-center border-2 border-dashed border-primary/20 rounded-[16px] p-6 hover:border-primary/40 hover:bg-primary/5 cursor-pointer transition-colors">
              <Upload className="w-8 h-8 text-primary/40 mb-2" />
              <span className="text-sm text-primary/60">
                Drop backup file here or click to upload
              </span>
              <span className="text-xs text-primary/35 mt-1">
                .tar, .tar.gz, or .tgz files
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".tar,.tar.gz,.tgz"
                className="hidden"
                onChange={handleFileSelect}
              />
            </label>
          )}
        </div>
        </div>
      </div>

      {/* Unattached Backups Section */}
      {unattachedBackups.length > 0 && (
        <div
          className="bg-secondary rounded-large-element overflow-hidden transition-all ease-[var(--motion-easing-emphasized-decelerate)]"
          style={{ transitionDuration: "var(--motion-duration-medium2)" }}
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
            <HardDrive size={18} className="text-accent" />
            <h2 className="font-mono font-normal text-primary">Unattached Backups</h2>
            <InfoPopover>
              These backups are not linked to any installed app. They may have been uploaded manually, or the original app was deleted. Restore them to any installed app.
            </InfoPopover>
          </div>

          <div
            className="animate-in fade-in slide-in-from-bottom-2 divide-y divide-primary/10"
            style={{ animationDuration: "var(--motion-duration-medium2)" }}
          >
            {unattachedBackups.map((backup) => (
              <div key={backup.id} className="px-4 py-3 flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm text-primary truncate">
                    {backup.path?.split("/").pop() || "Unknown"}
                  </div>
                  <div className="text-xs text-accent mt-0.5 flex items-center gap-2">
                    <span>{formatDate(backup.created_at)}</span>
                    <span>·</span>
                    <span>{formatBytes(backup.size)}</span>
                    {backup.source === "uploaded" && (
                      <>
                        <span>·</span>
                        <span className="text-primary/40">Uploaded</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <a
                    href={`/api/v1/backups/${backup.id}/download`}
                    download
                    className="p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                    title="Download"
                  >
                    <Download size={14} />
                  </a>
                  <button
                    onClick={() => setShowAppSelector(backup)}
                    className="p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                    title="Restore to App"
                  >
                    <Upload size={14} />
                  </button>
                  <button
                    onClick={() => setShowDeleteModal(backup)}
                    className="p-1.5 rounded-pill hover:bg-error/10 text-accent/50 hover:text-error transition-all"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              ))}
            </div>
        </div>
      )}

      {/* Database Backup Section */}
      <div
        ref={databaseCard.outerRef}
        className="bg-secondary rounded-large-element overflow-hidden transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
        style={{ transitionDuration: "var(--motion-duration-medium2)" }}
      >
        <div ref={databaseCard.innerRef}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <DatabaseBackup size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary">Database Backup</h2>
          <InfoPopover>
            Database backups contain LibreServ&apos;s system configuration, user accounts, and app records. Restore with caution - this replaces the entire system state.
          </InfoPopover>
        </div>

        <div
          className="animate-in fade-in slide-in-from-bottom-2 p-4 flex flex-col sm:flex-row gap-3"
          style={{ animationDuration: "var(--motion-duration-medium2)" }}
        >
          <button
            onClick={handleSaveDatabase}
            disabled={savingDb}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-pill bg-primary text-secondary hover:opacity-90 transition-opacity disabled:opacity-40 font-mono text-sm"
          >
            {savingDb ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Save size={16} />
            )}
            {savingDb ? "Saving..." : "Save DB"}
          </button>

          <label className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-pill border border-primary/20 text-primary hover:bg-primary/5 cursor-pointer transition-colors font-mono text-sm">
            {uploadingDb ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Restoring...
              </>
            ) : (
              <>
                <Upload size={16} />
                Upload & Restore DB
              </>
            )}
            <input
              ref={dbFileInputRef}
              type="file"
              accept=".gz,.db"
              className="hidden"
              onChange={handleDbFileSelect}
              disabled={uploadingDb}
            />
          </label>
        </div>
        </div>
      </div>

      {/* Backup Schedules Section */}
      <ScheduleForm />

      {/* Cloud Backup Section */}
      <div
        ref={cloudCard.outerRef}
        className="bg-secondary rounded-large-element overflow-hidden transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
        style={{ transitionDuration: "var(--motion-duration-medium2)" }}
      >
        <div ref={cloudCard.innerRef}>
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

        <div
          className={`overflow-hidden transition-all ease-[var(--motion-easing-emphasized)] ${
            showCloudConfig ? "max-h-[800px] opacity-100" : "max-h-0 opacity-0"
          }`}
          style={{ transitionDuration: "var(--motion-duration-medium2)" }}
        >
          <div className="p-4">
            <CloudBackupConfig onConfigured={() => setShowCloudConfig(false)} />
          </div>
        </div>
        {!showCloudConfig && (
          <div
            className="animate-in fade-in slide-in-from-bottom-2 px-4 py-6 text-center"
            style={{ animationDuration: "var(--motion-duration-medium2)" }}
          >
            <Cloud className="w-8 h-8 text-primary/30 mx-auto mb-2" />
             <p className="text-sm text-accent">
               Configure cloud backup for off-site storage
             </p>
             <button
               onClick={() => setShowCloudConfig(true)}
               className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-2 transition-all font-mono text-sm"
             >
               Configure Cloud Backup
             </button>
          </div>
        )}
        </div>
      </div>

      {/* Create Backup Modal */}
      {showCreateModal && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
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
          <Card className="w-full max-w-md p-6 border-2 border-accent" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-mono text-lg text-primary mb-4">Create Backup</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-mono text-primary/70 mb-2">
                  Select App
                </label>
                <select
                  value={selectedApp}
                  onChange={(e) => setSelectedApp(e.target.value)}
                   className="w-full px-3 py-2 bg-primary/10 border border-primary/20 rounded-pill font-mono text-sm text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
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
                 className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-2 transition-all font-mono text-sm disabled:opacity-50"
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
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
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
          <Card className="w-full max-w-md p-6 border-2 border-accent" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-6 h-6 text-warning mt-0.5" />
              <div>
                <h2 className="font-mono text-lg text-primary">Restore Backup</h2>
                <p className="font-mono text-sm text-primary/70 mt-1">
                  This will replace the current data for{" "}
                  <strong>{getAppDisplayName(showRestoreModal)}</strong>.
                </p>
              </div>
            </div>
            <div className="bg-warning/10 border border-warning/30 rounded-card p-3 mb-4">
              <p className="font-mono text-xs text-warning">
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
                 className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-warning text-primary hover:ring-warning hover:ring-2 transition-all font-mono text-sm"
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
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowDeleteModal(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setShowDeleteModal(null);
            }
          }}
          tabIndex={-1}
        >
          <Card className="w-full max-w-md p-6 border-2 border-accent" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-6 h-6 text-error mt-0.5" />
              <div>
                <h2 className="font-mono text-lg text-primary">Delete Backup</h2>
                <p className="font-mono text-sm text-primary/70 mt-1">
                  Backup for <strong>{getAppDisplayName(showDeleteModal)}</strong> will be permanently deleted.
                </p>
              </div>
            </div>
            <div className="bg-error/10 border border-error/30 rounded-card p-3 mb-4">
              <p className="font-mono text-xs text-error">
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
                 className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-error text-primary hover:ring-error hover:ring-2 transition-all font-mono text-sm"
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

      {/* Restore App Selector Modal for Unattached Backups */}
      {showAppSelector && (
        <RestoreAppSelector
          backup={showAppSelector}
          apps={apps}
          onRestore={handleRestoreUnattachedBackup}
          onClose={() => setShowAppSelector(null)}
        />
      )}
    </div>
  );
}
