import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { lastCopyLine } from "../../lib/backupRows.js";

/**
 * BackupStatusNotice — why a backup is out of date, shown where it's
 * managed. Renders nothing while the backup is working. The same problem
 * shows in the dashboard's system health pill.
 *
 * @param {{
 *   state?: "ok" | "failing" | "stale",
 *   lastError?: string,
 *   lastOkAt?: number,
 *   staleText?: string,
 *   surface?: "primary" | "secondary",
 * }} props
 */
export default function BackupStatusNotice({ state, lastError, lastOkAt, staleText, surface }) {
  if (!state || state === "ok") return null;
  return (
    <PageNotice variant="warning" surface={surface}>
      {(lastError || staleText) && <p>{lastError || staleText}</p>}
      <p>{lastCopyLine({ last_ok_at: lastOkAt })}</p>
    </PageNotice>
  );
}
