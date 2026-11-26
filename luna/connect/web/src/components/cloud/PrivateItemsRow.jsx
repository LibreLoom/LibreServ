import { Lock } from "lucide-react";
import { Chip } from "./Chip.jsx";
import { BackupRow } from "./BackupRow.jsx";

/**
 * The "Private backups" area. It is always shown and never lists owners: it looks the same for
 * every phrase until one opens something, and then it holds every private backup that phrase opens.
 * @param {{ backups: import("../../lib/cloudUnlock.js").CloudBackup[],
 *   onOpen: (protectionId: string) => void }} props
 */
export function PrivateItemsRow({ backups, onOpen }) {
  const opened = backups.length > 0;
  return (
    <section aria-label="Private backups" className="rounded-large-element border border-dashed border-border p-4 space-y-3">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-pill bg-secondary" aria-hidden="true">
          <Lock className="size-4" />
        </span>
        <div className="space-y-1">
          <h4 className="font-mono text-base">Private backups</h4>
          <p className="text-sm text-muted-foreground">
            {opened ? "Opened with your recovery phrase." : "Only the owner's recovery phrase opens private backups."}
          </p>
        </div>
        {opened ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Chip>Opened</Chip>
          </div>
        ) : null}
      </div>
      {backups.map((backup) => (
        <BackupRow key={backup.protectionId} backup={backup} onOpen={onOpen} />
      ))}
    </section>
  );
}
