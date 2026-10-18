import { Button } from "../ui/button.jsx";
import { formatWhen } from "../../lib/cloudTree.js";

const ROW_CLASS = "rounded-large-element border border-border px-4 py-3 flex flex-wrap items-center justify-between gap-3";

/**
 * The "Private items" row at the end of a user's group. Connect never shows
 * names, counts or sizes for someone else's private items; only that person's
 * recovery phrase opens them.
 * @param {{ kind: "mine" | "other",
 *   backups: import("../../lib/cloudUnlock.js").CloudBackup[],
 *   onOpen: (protectionId: string) => void }} props
 */
export function PrivateItemsRow({ kind, backups, onOpen }) {
  const mine = kind === "mine";
  return (
    <section aria-label="Private items" className="rounded-large-element border border-border px-4 py-3 space-y-3">
      <div className="space-y-1">
        <h4 className="font-mono text-base">Private items</h4>
        {mine ? (
          <>
            <p className="text-sm text-muted-foreground">Only this person's recovery phrase opens these.</p>
            <p className="text-sm text-muted-foreground">Opened with your recovery phrase.</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Only this person's recovery phrase opens these.</p>
        )}
      </div>
      {mine
        ? backups.map((backup) => {
            const count = backup.versions.length;
            return (
              <div key={backup.protectionId} className={ROW_CLASS}>
                <div className="min-w-0">
                  <p className="text-sm">{backup.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {count === 1 ? "1 version" : `${count} versions`} · Latest {formatWhen(backup.versions[0].createdAt)}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => onOpen(backup.protectionId)}>
                  Open
                </Button>
              </div>
            );
          })
        : null}
    </section>
  );
}
