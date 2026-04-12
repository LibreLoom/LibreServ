import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";
import { DatabaseBackup, Download, Trash2, AlertTriangle } from "lucide-react";
import LocalBackupsCard from "../../backups/LocalBackupsCard";
import UploadBackupCard from "../../backups/UploadBackupCard";
import UnattachedBackupsCard from "../../backups/UnattachedBackupsCard";
import DatabaseBackupCard from "../../backups/DatabaseBackupCard";
import CloudBackupCard from "../../backups/CloudBackupCard";
import ScheduleForm from "../../backups/ScheduleForm";
import RestoreAppSelector from "../../backups/RestoreAppSelector";
import ConfirmModal from "../../common/ConfirmModal";

export default function BackupsCategory() {
  const { request } = useAuth();
  const { addToast } = useToast();
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

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showSuccess = useCallback((message, description) => {
    addToast({ type: "success", message, description });
  }, [addToast]);

  const showError = useCallback((message, description) => {
    addToast({ type: "error", message, description });
  }, [addToast]);

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
        body: JSON.stringify({ app_id: selectedApp, stop_before_backup: false, compress: true }),
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
      const res = await request(`/backups/${showRestoreModal.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stop_before_restore: true, restart_after_restore: true, verify_checksum: true }),
      });
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
      const res = await request(`/backups/${showDeleteModal.id}`, { method: "DELETE" });
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
      const res = await request(`/backups/${backup.id}/upload`, { method: "POST" });
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
    if (fileInputRef.current) fileInputRef.current.value = "";
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
        body: JSON.stringify({ target_app_id: targetAppId, stop_before_restore: true, restart_after_restore: true, verify_checksum: true }),
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
      const res = await request("/backups/database", { method: "POST" });
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
      if (dbFileInputRef.current) dbFileInputRef.current.value = "";
    }
  }

  function getAppDisplayName(backup) {
    const app = apps.find((a) => a.id === backup.app_id);
    return app?.name || backup.app_id || "System";
  }

  return (
    <div className="space-y-4">
      <LocalBackupsCard
        backups={backups}
        apps={apps}
        loading={loading}
        loadError={loadError}
        onRetry={loadData}
        onCreate={() => setShowCreateModal(true)}
        onRestore={(backup) => setShowRestoreModal(backup)}
        onDelete={(backup) => setShowDeleteModal(backup)}
        onUploadToCloud={handleUploadToCloud}
        uploadingId={uploading}
      />

      <UploadBackupCard
        uploadFile={uploadFile}
        onFileSelect={handleFileSelect}
        onUploadComplete={handleUploadComplete}
        onUploadError={handleUploadError}
        fileInputRef={fileInputRef}
      />

      <UnattachedBackupsCard
        backups={unattachedBackups}
        onRestore={(backup) => setShowAppSelector(backup)}
        onDelete={(backup) => setShowDeleteModal(backup)}
      />

      <DatabaseBackupCard
        savingDb={savingDb}
        uploadingDb={uploadingDb}
        onSaveDb={handleSaveDatabase}
        onDbFileSelect={handleDbFileSelect}
        dbFileInputRef={dbFileInputRef}
      />

      <ScheduleForm />

      <CloudBackupCard
        showConfig={showCloudConfig}
        onToggleConfig={() => setShowCloudConfig(!showCloudConfig)}
        onConfigured={() => setShowCloudConfig(false)}
      />

      <ConfirmModal
        open={showCreateModal}
        onClose={() => { setShowCreateModal(false); setSelectedApp(""); }}
        onConfirm={handleCreateBackup}
        icon={DatabaseBackup}
        title="Create Backup"
        confirmLabel="Create"
        confirmIcon={DatabaseBackup}
        loading={creating}
      >
        <div className="mt-3">
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
              <option key={app.id} value={app.id}>{app.name}</option>
            ))}
          </select>
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={!!showRestoreModal}
        onClose={() => setShowRestoreModal(null)}
        onConfirm={handleRestoreBackup}
        icon={AlertTriangle}
        title="Restore Backup"
        message={showRestoreModal ? `This will replace the current data for ${getAppDisplayName(showRestoreModal)}.` : ""}
        variant="warning"
        confirmLabel="Restore"
        confirmIcon={Download}
        loading={restoring}
      />

      <ConfirmModal
        open={!!showDeleteModal}
        onClose={() => setShowDeleteModal(null)}
        onConfirm={handleDeleteBackup}
        icon={Trash2}
        title="Delete Backup"
        message={showDeleteModal ? `Backup for ${getAppDisplayName(showDeleteModal)} will be permanently deleted.` : ""}
        variant="danger"
        confirmLabel="Delete"
        confirmIcon={Trash2}
        loading={deleting}
      />

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
