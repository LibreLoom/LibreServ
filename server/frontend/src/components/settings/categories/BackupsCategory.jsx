import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";
import { DatabaseBackup, Download, Trash2, AlertTriangle, RotateCcw, Loader2 } from "lucide-react";
import LocalBackupsCard from "../../backups/LocalBackupsCard";
import DatabaseBackupCard from "../../backups/DatabaseBackupCard";
import BackupRepoConfig from "../../backups/BackupRepoConfig";
import ScheduleForm from "../../backups/ScheduleForm";
import ConfirmModal from "../../common/ConfirmModal";
import ModalCard from "../../cards/ModalCard";
import Dropdown from "../../common/Dropdown";

export default function BackupsCategory() {
  const { request } = useAuth();
  const { addToast } = useToast();
  const [backups, setBackups] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(null);
  const [selectedApp, setSelectedApp] = useState("");
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingDb, setSavingDb] = useState(false);
  const [uploadingDb, setUploadingDb] = useState(false);
  const [pendingDbFile, setPendingDbFile] = useState(null);
  const dbFileInputRef = useRef(null);

  const showSuccess = useCallback((message, description) => {
    addToast({ type: "success", message, description });
  }, [addToast]);

  const showError = useCallback((message, description) => {
    addToast({ type: "error", message, description });
  }, [addToast]);

  const loadData = useCallback(async () => {
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
  }, [request]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleCreateBackup() {
    if (!selectedApp) return;
    setCreating(true);
    try {
      const res = await request("/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: selectedApp, stop_before_backup: false }),
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

  async function handleSaveDatabase() {
    setSavingDb(true);
    try {
      const res = await request("/backups/database", { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to save database");
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `libreserv-db-${new Date().toISOString().slice(0, 10)}.db.gz`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
      showSuccess("Database saved", "Database backup downloaded successfully.");
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
    setPendingDbFile(file);
  }

  async function handleConfirmDbRestore() {
    if (!pendingDbFile) return;
    await uploadAndRestoreDatabase(pendingDbFile);
    setPendingDbFile(null);
  }

  async function uploadAndRestoreDatabase(file) {
    setUploadingDb(true);
    try {
      const formData = new FormData();
      formData.append("backup", file);
      const res = await request("/backups/database/upload-restore", {
        method: "POST",
        body: formData,
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
      />

      <DatabaseBackupCard
        savingDb={savingDb}
        uploadingDb={uploadingDb}
        onSaveDb={handleSaveDatabase}
        onDbFileSelect={handleDbFileSelect}
        dbFileInputRef={dbFileInputRef}
      />

      <ScheduleForm />

      <BackupRepoConfig />

      {showCreateModal && (
        <ModalCard
          title="Create Backup"
          onClose={() => { setShowCreateModal(false); setSelectedApp(""); }}
        >
          <p className="text-xs text-primary/50 mb-4">
            Create a backup of an app's data. You can restore from it later if something goes wrong.
          </p>
          <label className="block text-sm font-mono text-primary/70 mb-2">
            Select App
          </label>
          <Dropdown
            value={selectedApp}
            onChange={setSelectedApp}
            placeholder="Select an app..."
            fullWidth
            bg="primary"
            options={apps.map((app) => ({ value: app.id, label: app.name }))}
          />
          <div className="flex gap-3 mt-4">
            <button
              onClick={() => { setShowCreateModal(false); setSelectedApp(""); }}
              disabled={creating}
              className="flex-1 px-4 py-2 rounded-pill border-2 border-accent/30 bg-secondary text-primary hover:bg-accent/20 transition-all font-mono text-sm disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateBackup}
              disabled={creating || !selectedApp}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-2 hover:ring-accent transition-all font-mono text-sm disabled:opacity-50"
            >
              {creating ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <DatabaseBackup size={16} aria-hidden="true" />}
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </ModalCard>
      )}

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

      <ConfirmModal
        open={!!pendingDbFile}
        onClose={() => { setPendingDbFile(null); if (dbFileInputRef.current) dbFileInputRef.current.value = ""; }}
        onConfirm={handleConfirmDbRestore}
        icon={RotateCcw}
        title="Restore Database"
        message={pendingDbFile ? `This will replace the current database with ${pendingDbFile.name}. All current data will be lost.` : ""}
        variant="danger"
        confirmLabel="Restore"
        confirmIcon={RotateCcw}
        loading={uploadingDb}
      />
    </div>
  );
}
