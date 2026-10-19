import { useState } from "react";
import { Shield } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { backupHeadline, lastTestedLine } from "../../lib/backupRows.js";
import AllBackupsModal from "./AllBackupsModal.jsx";

/**
 * One quiet row on the dashboard: how backed up things are, and a way to see every backup.
 * Hidden when there are no backups.
 * @param {{ rows?: any[] }} props
 */
export default function BackupsLine({ rows }) {
  const [showAll, setShowAll] = useState(false);
  if (!rows || rows.length === 0) return null;
  return (
    <section aria-label="Backups">
      <Card padding={false}>
        {/* Layout classes go on this inner row, not on Card: Card's className lands on its height-animated clip, which would clip the row. */}
        <div className="p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Shield size={ICON_SIZE.lg} className="shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-base font-mono font-normal">{backupHeadline(rows)}</p>
              <p className="text-xs">{lastTestedLine(rows)}</p>
            </div>
          </div>
          <Button size="sm" variant="primary" onClick={() => setShowAll(true)}>
            See all backups
          </Button>
        </div>
      </Card>
      {showAll && <AllBackupsModal open={showAll} onClose={() => setShowAll(false)} backups={rows} />}
    </section>
  );
}
