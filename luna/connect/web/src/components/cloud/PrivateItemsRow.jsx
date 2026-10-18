import { Lock } from "lucide-react";
import { BackupRow } from "./BackupRow.jsx";

/**
 * The "Private items" block at the end of a user's group. Connect never shows
 * names, counts or sizes for someone else's private items; only that person's
 * recovery phrase opens them.
 * @param {{ kind: "mine" | "other",
 *   backups: import("../../lib/cloudUnlock.js").CloudBackup[],
 *   onOpen: (protectionId: string) => void }} props
 */
export function PrivateItemsRow({ kind, backups, onOpen }) {
  const mine = kind === "mine";
  return (
    <section aria-label="Private items" className="rounded-large-element border border-dashed border-border p-4 space-y-3">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-pill bg-secondary" aria-hidden="true">
          <Lock className="size-4" />
        </span>
        <div className="space-y-1">
          <h4 className="font-mono text-base">Private items</h4>
          <p className="text-sm text-muted-foreground">Only this person's recovery phrase opens these.</p>
          {mine ? <p className="text-sm text-muted-foreground">Opened with your recovery phrase.</p> : null}
        </div>
      </div>
      {mine ? backups.map((backup) => <BackupRow key={backup.protectionId} backup={backup} onOpen={onOpen} />) : null}
    </section>
  );
}
