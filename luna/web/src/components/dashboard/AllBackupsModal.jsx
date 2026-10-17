/* eslint-disable react-refresh/only-export-components -- helpers shared with BackupsCard and tests */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { getJson } from "../../lib/api";
import { formatRecentAgo } from "../../lib/recentItems";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import ProtectSheet from "../files/ProtectSheet.jsx";

/**
 * A backup needs a look when it is still running and its last copy failed
 * or went stale. Stopped and deleted-source backups are finished, not broken.
 * @param {any} b
 */
export function needsALook(b) {
  return b.status === "active" && (b.state === "failing" || b.state === "stale");
}

/**
 * Status pill for one backup row.
 * @param {any} b
 * @returns {{ label: string, variant: "success"|"warning"|"error"|"muted" }}
 */
export function backupStatus(b) {
  if (b.status === "stopped") return { label: "Stopped", variant: "muted" };
  if (b.status === "source_gone") return { label: "Source deleted", variant: "muted" };
  if (needsALook(b)) {
    return { label: "Needs a look", variant: b.state === "failing" ? "error" : "warning" };
  }
  return { label: "Backed up", variant: "success" };
}

/** Most urgent first: hard errors, then the oldest good copy (0 = never). */
export function sortByUrgency(list) {
  return [...list].sort(
    (a, b) => Number(!!b.hard) - Number(!!a.hard) || (a.last_ok_at || 0) - (b.last_ok_at || 0),
  );
}

/** @param {any} b @param {number} [now] */
export function lastGoodCopyLine(b, now = Date.now()) {
  return b.last_ok_at
    ? `Last good copy ${formatRecentAgo(b.last_ok_at * 1000, now)}`
    : "No good copy yet";
}

/** Name shown for a backup's creator, or "Someone" when unknown. */
export function creatorName(userId, users) {
  const u = (users || []).find((x) => x.id === userId);
  return u ? u.display_name || u.username : "Someone";
}

const FILTERS = [
  { value: "all", label: "All" },
  { value: "needs", label: "Needs a look" },
  { value: "drives", label: "Drives" },
];

function filterBackups(list, filter) {
  if (filter === "needs") return list.filter(needsALook);
  if (filter === "drives") return list.filter((b) => b.kind === "drive");
  return list;
}

/** Groups backups by creator, keeping the order of `list`. */
export function groupByCreator(list, users) {
  const groups = new Map();
  for (const b of list) {
    const name = creatorName(b.created_by, users);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(b);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => Number(a === "Someone") - Number(b === "Someone") || a.localeCompare(b))
    .map(([name, items]) => ({ name, items: sortByUrgency(items) }));
}

function BackupRow({ backup, onOpen }) {
  const status = backupStatus(backup);
  const active = backup.status === "active";
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium min-w-0 break-words">{backup.source_name}</span>
        <Pill variant={status.variant}>{status.label}</Pill>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Pill>{backup.target_drive_name}</Pill>
        <span>{lastGoodCopyLine(backup)}</span>
      </div>
      {!active && (
        <p className="text-sm">
          Copies are in the Backups folder on <InlinePill>{backup.target_drive_name}</InlinePill>
        </p>
      )}
    </>
  );
  return (
    <li>
      {active ? (
        <button
          type="button"
          aria-label={`Open protection for ${backup.source_name}`}
          onClick={() => {
            haptic("selection");
            onOpen(backup);
          }}
          className="surface-primary rounded-large-element p-3 w-full text-left flex flex-col gap-2 cursor-pointer motion-safe:transition-all focus-visible:ring-2 focus-visible:ring-accent outline-none"
        >
          {body}
        </button>
      ) : (
        <div className="surface-primary rounded-large-element p-3 flex flex-col gap-2">{body}</div>
      )}
    </li>
  );
}

/**
 * Every drive backup Luna knows about, grouped by who made it.
 * @param {{ open: boolean, onClose: () => void, backups: any[] }} props
 */
export default function AllBackupsModal({ open, onClose, backups = [] }) {
  const [filter, setFilter] = useState("all");
  const [sheet, setSheet] = useState(null);
  // Members may not be allowed to list users; then names fall back to "Someone".
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => getJson("/api/v1/users"),
    retry: false,
  });
  const groups = groupByCreator(filterBackups(backups, filter), users.data);

  return (
    <>
      <ModalCard open={open} onClose={onClose} title="All backups">
        <div className="flex flex-col gap-4">
          <SegmentedControl
            aria-label="Filter backups"
            options={FILTERS}
            value={filter}
            onChange={setFilter}
          />
          {groups.length === 0 && (
            <p>
              {backups.length === 0 ? "No backups yet." : "No backups match this filter."}
            </p>
          )}
          {groups.map((group) => (
            <section key={group.name} className="flex flex-col gap-2">
              <h3 className="text-base">{group.name}</h3>
              <ul className="flex flex-col gap-2">
                {group.items.map((b) => (
                  <BackupRow key={b.id} backup={b} onOpen={setSheet} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </ModalCard>
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
