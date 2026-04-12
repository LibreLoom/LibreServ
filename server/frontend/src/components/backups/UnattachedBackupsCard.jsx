import { HardDrive, Download, Upload, Trash2 } from "lucide-react";
import Card from "../common/cards/Card";
import InfoPopover from "../common/InfoPopover";
import { formatDate, formatBytes } from "../../lib/backups-utils";

export default function UnattachedBackupsCard({
  backups,
  onRestore,
  onDelete,
}) {
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
                onClick={() => onRestore(backup)}
                className="p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                title="Restore to App"
              >
                <Upload size={14} />
              </button>
              <button
                onClick={() => onDelete(backup)}
                className="p-1.5 rounded-pill hover:bg-error/10 text-accent/50 hover:text-error transition-all"
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
