import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import { getJson } from "../../lib/api";
import {
  backupHeadline,
  backupStatus,
  buildBackupRows,
  CARD_PROBLEM_LIMIT,
  lastGoodCopyLine,
  lastTestedLine,
  needsALook,
  sortByUrgency,
} from "../../lib/backupRows.js";
import { getPhraseStatus, PHRASE_QUERY_KEY } from "../../lib/cloudPhrase";
import ProtectSheet from "../files/ProtectSheet.jsx";
import RecoveryPhraseCheck from "../cloud/RecoveryPhraseCheck.jsx";
import AllBackupsModal from "./AllBackupsModal.jsx";

const MISSING_SOURCE_REASON = "The folder or drive this backs up is not available right now.";
const FALLBACK_REASON = "The last copy did not finish. Open it to see what went wrong.";

/**
 * @param {{
 *   rows: any[],
 *   remind: boolean,
 *   onOpenAll: () => void,
 *   onOpenProblem: (b: any) => void,
 *   onCheckPhrase: () => void,
 * }} props
 */
function BackupsSummary({ rows, remind, onOpenAll, onOpenProblem, onCheckPhrase }) {
  const failing = sortByUrgency(rows.filter(needsALook));
  // At most CARD_PROBLEM_LIMIT items in total. Failing rows come first, so the reminder only fills a free slot.
  const problems = failing.slice(0, CARD_PROBLEM_LIMIT);
  const showReminder = remind && problems.length < CARD_PROBLEM_LIMIT;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-lg font-medium">{backupHeadline(rows)}</p>
        <p>{lastTestedLine(rows)}</p>
      </div>
      {(problems.length > 0 || showReminder) && (
        <ul className="flex flex-col gap-3">
          {problems.map((b) => (
            <li key={`${b.kind}-${b.id}`} className="surface-primary rounded-large-element p-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium min-w-0 break-words">{b.source_name}</span>
                <Pill variant={backupStatus(b).variant}>{backupStatus(b).label}</Pill>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Pill>{b.destination}</Pill>
              </div>
              <p className="text-sm">{b.last_error || b.check_problem || (b.source_missing ? MISSING_SOURCE_REASON : FALLBACK_REASON)}</p>
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
          {showReminder && (
            <li className="surface-primary rounded-large-element p-3 flex flex-col gap-2">
              <span className="font-medium">Check your recovery phrase</span>
              <p className="text-sm">It&apos;s been a while. Make sure your 12 words still open your cloud backups.</p>
              <div>
                <Button variant="outline" surface="primary" size="sm" onClick={onCheckPhrase}>
                  Check now
                </Button>
              </div>
            </li>
          )}
        </ul>
      )}
      {rows.length > 0 && (
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
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [checkingPhrase, setCheckingPhrase] = useState(false);
  const backupsQuery = useQuery({
    queryKey: ["backups"],
    queryFn: () => getJson("/api/v1/backups"),
    retry: false,
  });
  // Connect may be off, so a failed cloud query only means no cloud rows.
  const cloudQuery = useQuery({
    queryKey: ["cloud-backups"],
    queryFn: () => getJson("/api/v1/cloud/backups"),
    retry: false,
  });
  const phrase = useQuery({
    queryKey: PHRASE_QUERY_KEY,
    queryFn: getPhraseStatus,
    retry: false,
  });

  const rows = backupsQuery.data
    ? buildBackupRows(backupsQuery.data, cloudQuery.data ?? [])
    : [];
  const remind = !!phrase.data?.check_due && rows.some((r) => r.kind === "cloud");

  let body;
  if (backupsQuery.isError) {
    body = <p>Could not load backups. Try again later.</p>;
  } else if (!backupsQuery.data || cloudQuery.isPending) {
    body = <p>Loading backups…</p>;
  } else {
    body =
      rows.length === 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-lg font-medium">No backups yet.</p>
          <p>Click the shield icon beside an item to back it up.</p>
        </div>
      ) : (
        <BackupsSummary
          rows={rows}
          remind={remind}
          onOpenAll={() => setShowAll(true)}
          onOpenProblem={setSheet}
          onCheckPhrase={() => setCheckingPhrase(true)}
        />
      );
  }

  function closeCheck() {
    setCheckingPhrase(false);
    queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY });
  }

  return (
    <>
      <Card icon={Shield} title="Backups">
        {body}
      </Card>
      {showAll && <AllBackupsModal open={showAll} onClose={() => setShowAll(false)} backups={rows} />}
      {sheet && (
        <ProtectSheet
          driveId={sheet.source_drive}
          path={sheet.source_path}
          onClose={() => setSheet(null)}
        />
      )}
      {checkingPhrase && phrase.data?.luna_id && (
        <RecoveryPhraseCheck lunaId={phrase.data.luna_id} onClose={closeCheck} />
      )}
    </>
  );
}
