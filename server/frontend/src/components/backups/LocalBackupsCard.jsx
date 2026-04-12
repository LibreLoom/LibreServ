import {
  HardDrive,
  Plus,
  Loader2,
  DatabaseBackup,
  Cloud,
  Download,
  CloudUpload,
  Trash2,
  RotateCcw,
  AlertTriangle,
  HelpCircle,
} from "lucide-react";
import Card from "../cards/Card";
import AppIcon from "../common/AppIcon";
import { formatDate, formatBytes } from "../../lib/backups-utils";

export default function LocalBackupsCard({
  backups,
  apps,
  loading,
  loadError,
  onRetry,
  onCreate,
  onRestore,
  onDelete,
  onUploadToCloud,
  uploadingId,
}) {
  function getAppDisplayName(backup) {
    const app = apps.find((a) => a.id === backup.app_id);
    if (app) return app.name;
    if (!backup.app_id) return "?";
    return backup.app_id;
  }

  function isOrphaned(backup) {
    return !backup.app_id || !apps.find((a) => a.id === backup.app_id);
  }

  function getAppCatalogId(backup) {
    const app = apps.find((a) => a.id === backup.app_id);
    return app?.app_id || null;
  }

  const recentBackups = backups.slice(0, 5);

  return (
    <Card
      icon={HardDrive}
      title="Local Backups"
      padding={false}
      headerActions={
        <button
          onClick={onCreate}
          className="flex items-center gap-1 text-xs text-accent hover:text-primary transition-colors"
        >
          <Plus size={14} aria-hidden="true" />
          Create
        </button>
      }
      className="animate-in fade-in slide-in-from-bottom-2"
    >
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
              onClick={onRetry}
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
              onClick={onCreate}
              className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-2 transition-all font-mono text-sm"
            >
              <Plus size={16} />
              Create Backup
            </button>
          </div>
        ) : (
          <div className="divide-y divide-primary/10">
            {recentBackups.map((backup) => {
              const isUploading = uploadingId === backup.id;
              return (
                <div key={backup.id} className="px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {isOrphaned(backup) ? (
                      <div
                        className="rounded-large-element bg-primary/10 flex items-center justify-center"
                        style={{ width: 28, height: 28 }}
                      >
                        <HelpCircle size={16} className="text-primary/50" />
                      </div>
                    ) : (
                      <AppIcon appId={getAppCatalogId(backup)} size={28} />
                    )}
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-primary truncate">
                        {getAppDisplayName(backup)}
                      </div>
                      <div className="text-xs text-accent mt-0.5 flex items-center gap-2">
                        <span>{formatDate(backup.created_at)}</span>
                        <span>·</span>
                        <span>{formatBytes(backup.size)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {backup.cloud_status?.has_cloud_copy ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-accent/20 text-accent text-xs mr-2">
                        <Cloud size={12} />
                        Cloud
                      </span>
                    ) : (
                      <>
                        <button
                          onClick={() => onUploadToCloud(backup)}
                          disabled={isUploading}
                          title="Upload to cloud"
                          className={`p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all mr-1 ${isUploading ? "opacity-50 cursor-wait" : ""}`}
                          aria-label="Upload to cloud"
                        >
                          {isUploading ? (
                            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                          ) : (
                            <CloudUpload size={14} aria-hidden="true" />
                          )}
                        </button>
                        <a
                          href={`/api/v1/backups/${backup.id}/download`}
                          download
                          title="Download backup"
                          className="p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                          aria-label="Download backup"
                        >
                          <Download size={14} aria-hidden="true" />
                        </a>
                        <button
                          onClick={() => onRestore(backup)}
                          title="Restore backup"
                          className="p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                          aria-label="Restore backup"
                        >
                          <RotateCcw size={14} aria-hidden="true" />
                        </button>
                        <button
                          onClick={() => onDelete(backup)}
                          title="Delete backup"
                          className="p-1.5 rounded-pill hover:bg-error/10 text-accent/50 hover:text-error transition-all"
                          aria-label="Delete backup"
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </>
                    )}
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
    </Card>
  );
}
