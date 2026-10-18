import { Link } from "react-router-dom";
import { History } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import {
  formatRecentAgo,
  recentItemHref,
  recentItemLocationLine,
  recentItemName,
} from "../../lib/recentItems.js";

/** The dashboard shows only the latest few; the full list is one folder away. */
const MAX_RECENTS = 6;

/**
 * Recents: the files, folders and drives the person opened last. Each row is one link that
 * re-opens the item and shows its name, where it lives and when it was opened. Items come from
 * the server-backed list the dashboard loads. Renders nothing when there is nothing to resume.
 *
 * The card is a surface-secondary panel and each row is a surface-primary link on it, so the
 * row's text inherits the row surface's own text color and sets none.
 *
 * @param {{
 *   items?: Array<import("../../lib/recentItems.js").RecentItem>,
 *   drives?: Array<{ id: string, label?: string }>,
 * }} props
 */
export default function RecentsCard({ items, drives = [] }) {
  if (!Array.isArray(items) || items.length === 0) return null;

  return (
    <Card icon={History} title="Recents">
      <ul className="space-y-3">
        {items.slice(0, MAX_RECENTS).map((item) => {
          const liveLabel = drives.find((d) => d.id === item.driveId)?.label;
          const name = recentItemName(item, liveLabel);
          const locationLine = recentItemLocationLine(item, liveLabel);
          return (
            <li key={`${item.kind}:${item.driveId}:${item.path}`}>
              <Link
                to={recentItemHref(item)}
                className="block rounded-large-element surface-primary p-4 no-focus-outline motion-safe:transition-shadow hover:ring-2 hover:ring-accent focus-visible:ring-2 focus-visible:ring-accent"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xl font-mono font-normal leading-tight truncate">
                      {name}
                    </div>
                    {locationLine ? (
                      <p className="text-sm mt-1 break-words">{locationLine}</p>
                    ) : null}
                  </div>
                  <time
                    className="text-xs font-mono shrink-0"
                    dateTime={new Date(item.at).toISOString()}
                  >
                    {formatRecentAgo(item.at)}
                  </time>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
