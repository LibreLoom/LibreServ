import { DatabaseBackup, Loader2, Save, Upload } from "lucide-react";
import Card from "../cards/Card";
import InfoPopover from "../common/InfoPopover";

export default function DatabaseBackupCard({
  savingDb,
  uploadingDb,
  onSaveDb,
  onDbFileSelect,
  dbFileInputRef,
}) {
  return (
    <Card
      icon={DatabaseBackup}
      title="Database Backup"
      padding={false}
      headerActions={
        <InfoPopover>
          Database backups contain LibreServ&apos;s system configuration, user accounts, and app records. Restore with caution - this replaces the entire system state.
        </InfoPopover>
      }
      className="animate-in fade-in slide-in-from-bottom-2"
    >
      <div
        className="animate-in fade-in slide-in-from-bottom-2 p-4 flex flex-col sm:flex-row gap-3"
        style={{ animationDuration: "var(--motion-duration-medium2)" }}
      >
        <button
          onClick={onSaveDb}
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
            onChange={onDbFileSelect}
            disabled={uploadingDb}
          />
        </label>
      </div>
    </Card>
  );
}
