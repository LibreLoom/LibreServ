/* eslint-disable react-refresh/only-export-components -- helpers shared with AllBackupsModal and tests */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Shield } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import { getJson } from "../../lib/api";
import ProtectSheet from "../files/ProtectSheet.jsx";
import AllBackupsModal, { backupStatus, lastGoodCopyLine, needsALook, sortByUrgency } from "./AllBackupsModal.jsx";

/** Most rows the card lists before "See all backups". */
export const CARD_PROBLEM_LIMIT = 3;

const FALLBACK_REASON = "The last copy did not finish. Open it to see what went wrong.";

/** Headline for the card's first line. */
export function backupHeadline(backups) {
  if (backups.length === 0) return "No backups yet";
  const count = backups.filter(needsALook).length;
  if (count === 0) return "All backed up";
  if (count === 1) return "1 backup needs a look";
  return `${count} backups need a look`;
}

/** Drive backups only for now; cloud rows get added here later. */
export function buildBackupRows(backups) {
  return backups.filter((b) => b.kind === "drive");
}

/** @param {{ backups: any[], onOpenAll: () => void, onOpenProblem: (b: any) => void }} props */
function BackupsSummary({ backups, onOpenAll, onOpenProblem }) {
  const problems = sortByUrgency(backups.filter(needsALook)).slice(0, CARD_PROBLEM_LIMIT);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-lg font-medium">{backupHeadline(backups)}</p>
        <p>
          {backups.length} {backups.length === 1 ? "backup" : "backups"}
        </p>
      </div>
      {problems.length > 0 && (
        <ul className="flex flex-col gap-3">
          {problems.map((b) => (
            <li key={b.id} className="surface-primary rounded-large-element p-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium min-w-0 break-words">{b.source_name}</span>
                <Pill variant={backupStatus(b).variant}>{backupStatus(b).label}</Pill>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Pill>{b.target_drive_name}</Pill>
              </div>
              <p className="text-sm">{b.last_error || FALLBACK_REASON}</p>
              <p className="text-sm">{lastGoodCopyLine(b)}</p>
              <div>
                <Button
                  variant="outline"
                  surface="primary"
                  size="sm"
                  onClick={() => onOpenProblem(b)}
                  aria-label={`Open ${b.source_name}`}
                >
                  Open
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {backups.length > 0 && (
        <div>
          <Button variant="outline" size="sm" onClick={onOpenAll}>
            See all backups
          </Button>
        </div>
      )}
    </div>
  );
}

export default function BackupsCard() {
  const [showAll, setShowAll] = useState(false);
  const [sheet, setSheet] = useState(null);
  const backupsQuery = useQuery({
    queryKey: ["backups"],
    queryFn: () => getJson("/api/v1/backups"),
    retry: false,
  });

  let body;
  if (backupsQuery.isError) {
    body = <p>Could not load backups. Try again later.</p>;
  } else if (!backupsQuery.data) {
    body = <p>Loading backups…</p>;
  } else {
    const backups = buildBackupRows(backupsQuery.data);
    body =
      backups.length === 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-lg font-medium">No backups yet.</p>
          <p>Click the shield icon beside an item to back it up.</p>
        </div>
      ) : (
        <BackupsSummary
          backups={backups}
          onOpenAll={() => setShowAll(true)}
          onOpenProblem={setSheet}
        />
      );
  }

  return (
    <>
      <Card icon={Shield} title="Backups">
        {body}
      </Card>
      {showAll && (
        <AllBackupsModal
          open={showAll}
          onClose={() => setShowAll(false)}
          backups={backupsQuery.data ? buildBackupRows(backupsQuery.data) : []}
        />
      )}
      {sheet && (
        <ProtectSheet
          driveId={sheet.source_drive}
          path={sheet.source_path}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
}
