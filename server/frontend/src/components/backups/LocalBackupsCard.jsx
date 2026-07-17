import {
  HardDrive,
  Plus,
  Loader2,
  DatabaseBackup,
  Trash2,
  RotateCcw,
  AlertTriangle,
  HelpCircle,
} from "lucide-react";
import Card from "../cards/Card";
import AppIcon from "../common/AppIcon";
import Button from "../ui/Button";
import { formatDate, formatBytes } from "../../lib/backups-utils";
import { useTimeFormat } from "../../hooks/useTimeFormat";

export default function LocalBackupsCard({
  backups,
  apps,
  loading,
  loadError,
  onRetry,
  onCreate,
  onRestore,
  onDelete,
}) {
  const { use12HourTime } = useTimeFormat();
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
      data-slot="local-backups-card"
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
            <Button variant="outline" surface="secondary" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : recentBackups.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <span className="opacity-50 block mb-2"><DatabaseBackup className="w-10 h-10 text-primary mx-auto" /></span>
            <p className="text-sm text-accent">No backups yet</p>
            <Button variant="primary" onClick={onCreate} className="mt-3">
              <Plus size={16} />
              Create Backup
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-primary/10">
            {recentBackups.map((backup) => (
              <div key={backup.id} className="px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {isOrphaned(backup) ? (
                    <div
                      className="rounded-large-element bg-primary/10 flex items-center justify-center"
                      style={{ width: 28, height: 28 }}
                    >
                      <span className="opacity-50"><HelpCircle size={16} className="text-primary" /></span>
                    </div>
                  ) : (
                    <AppIcon appId={getAppCatalogId(backup)} size={28} />
                  )}
                  <div className="min-w-0">
                    <div className="font-mono text-sm text-primary truncate">
                      {getAppDisplayName(backup)}
                    </div>
                    <div className="text-xs text-accent mt-0.5 flex items-center gap-2">
                      <span>{formatDate(backup.created_at, use12HourTime)}</span>
                      <span>·</span>
                      <span>{formatBytes(backup.size)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="iconSm"
                    onClick={() => onRestore(backup)}
                    title="Restore backup"
                    aria-label="Restore backup"
                  >
                    <span className="opacity-50"><RotateCcw size={14} className="text-accent" aria-hidden="true" /></span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="iconSm"
                    onClick={() => onDelete(backup)}
                    title="Delete backup"
                    aria-label="Delete backup"
                  >
                    <span className="opacity-50"><Trash2 size={14} className="text-accent" aria-hidden="true" /></span>
                  </Button>
                </div>
              </div>
            ))}
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
