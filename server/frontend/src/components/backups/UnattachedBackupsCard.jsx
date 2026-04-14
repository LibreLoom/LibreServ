import { HardDrive, Download, RotateCcw, Trash2 } from "lucide-react";
import Card from "../cards/Card";
import InfoPopover from "../common/InfoPopover";
import { formatDate, formatBytes } from "../../lib/backups-utils";
import { useTimeFormat } from "../../hooks/useTimeFormat";

export default function UnattachedBackupsCard({
  backups,
  onRestore,
  onDelete,
}) {
  const { use12HourTime } = useTimeFormat();
  if (backups.length === 0) return null;

  return (
    <Card
      icon={HardDrive}
      title="Unattached Backups"
      padding={false}
      headerActions={
        <InfoPopover>
          These backups are not linked to any installed app. They may have been uploaded manually, or the original app was deleted. Restore them to any installed app.
        </InfoPopover>
      }
      className="animate-in fade-in slide-in-from-bottom-2"
    >
      <div
        className="animate-in fade-in slide-in-from-bottom-2 divide-y divide-primary/10"
        style={{ animationDuration: "var(--motion-duration-medium2)" }}
      >
        {backups.map((backup) => (
          <div key={backup.id} className="px-4 py-3 flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <div className="font-mono text-sm text-primary truncate">
                {backup.path?.split("/").pop() || "Unknown"}
              </div>
              <div className="text-xs text-accent mt-0.5 flex items-center gap-2">
                <span>{formatDate(backup.created_at, use12HourTime)}</span>
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
                title="Download backup"
                className="p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                aria-label="Download backup"
              >
                <Download size={14} aria-hidden="true" />
              </a>
              <button
                onClick={() => onRestore(backup)}
                title="Restore backup to app"
                className="p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                aria-label="Restore backup to app"
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
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
