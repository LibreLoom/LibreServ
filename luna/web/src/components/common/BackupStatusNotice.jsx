import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { formatRecentAgo } from "../../lib/recentItems.js";

/**
 * BackupStatusNotice — why a backup is out of date, shown where it's
 * managed. Renders nothing while the backup is working. The same problem
 * shows in the dashboard's system health pill.
 *
 * @param {{
 *   state?: "ok" | "failing" | "stale",
 *   lastError?: string,
 *   lastOkAt?: number,
 *   staleText: string,
 *   surface?: "primary" | "secondary",
 * }} props
 */
export default function BackupStatusNotice({ state, lastError, lastOkAt, staleText, surface }) {
  if (!state || state === "ok") return null;
  const when = lastOkAt ? formatRecentAgo(lastOkAt * 1000).replace(/^Just now$/, "just now") : "never";
  return (
    <PageNotice variant="warning" surface={surface}>
      <p>{lastError || staleText}</p>
      <p>Last full copy: {when}</p>
    </PageNotice>
  );
}
