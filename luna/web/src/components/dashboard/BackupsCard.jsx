import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, KeyRound, Shield } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { getJson } from "../../lib/api";
import {
  backupHeadline,
  buildBackupRows,
  CARD_PROBLEM_LIMIT,
  lastTestedLine,
  needsALook,
  sortByUrgency,
} from "../../lib/backupRows.js";
import { getPhraseStatus, PHRASE_QUERY_KEY } from "../../lib/cloudPhrase";
import ProtectSheet from "../files/ProtectSheet.jsx";
import RecoveryPhraseCheck from "../cloud/RecoveryPhraseCheck.jsx";
import BackupItem from "../protect/BackupItem.jsx";
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
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span
            className="inline-block h-2 w-2 rounded-full shrink-0 surface-primary"
            aria-hidden="true"
          />
          <span className="text-xs font-mono">{lastTestedLine(rows)}</span>
        </div>
        <p className="text-3xl font-mono font-normal leading-tight text-primary">{backupHeadline(rows)}</p>
      </div>
      {(problems.length > 0 || showReminder) && (
        <ul className="flex flex-col gap-3">
          {problems.map((b) => (
            <li key={`${b.kind}-${b.id}`}>
              <BackupItem
                backup={b}
                surface="primary"
                note={<p>{b.last_error || b.check_problem || (b.source_missing ? MISSING_SOURCE_REASON : FALLBACK_REASON)}</p>}
              >
                <Button
                  variant="outline"
                  surface="primary"
                  size="sm"
                  onClick={() => onOpenProblem(b)}
                  aria-label={`Open ${b.source_name}`}
                >
                  Open
                </Button>
              </BackupItem>
            </li>
          ))}
          {showReminder && (
            <li className="surface-primary rounded-large-element p-4 space-y-3">
              <div className="flex items-center gap-2">
                <KeyRound size={ICON_SIZE.sm} aria-hidden="true" />
                <span className="text-xs font-mono">Recovery phrase</span>
              </div>
              <p className="text-xl font-mono font-normal leading-tight">Check your recovery phrase</p>
              <p className="text-sm">It&apos;s been a while. Make sure your 12 words still open your cloud backups.</p>
              <Button variant="outline" surface="primary" size="sm" onClick={onCheckPhrase}>
                Check now
              </Button>
            </li>
          )}
        </ul>
      )}
      <Button size="md" variant="primary" fullWidth className="justify-between" onClick={onOpenAll}>
        <span>See all backups</span>
        <ChevronRight size={16} aria-hidden="true" />
      </Button>
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
        <EmptyState
          surface="primary"
          icon={Shield}
          title="No backups yet"
          description="Click the shield icon beside a drive or folder to back it up."
        />
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
