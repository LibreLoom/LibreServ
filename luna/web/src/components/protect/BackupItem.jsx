import PropTypes from "prop-types";
import { Cloud, HardDrive, Lock } from "lucide-react";
import { cn } from "@libreloom/ui/lib/utils.js";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import BackupNotes from "./BackupNotes.jsx";
import PausedByLockNote from "./PausedByLockNote.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { backupKindLabel, backupStatus, backupWaitingReason, isPausedByLock, lastCopyLine } from "../../lib/backupRows.js";

/**
 * One backup as a layered row: kind eyebrow with its status pill, the name in mono, a pill for
 * where the copies live, when the last copy finished, then any note and actions (children).
 * Same shape as the dashboard's Recents rows. `surface` is the row's own surface; put it on the
 * opposite of what it sits on (cards are secondary, so rows there are primary).
 *
 * @param {{
 *   backup: any,
 *   surface?: "primary" | "secondary",
 *   note?: import("react").ReactNode,
 *   children?: import("react").ReactNode,
 *   className?: string,
 * }} props
 */
export default function BackupItem({ backup, surface = "primary", note = null, children = null, className }) {
  const status = backupStatus(backup);
  // lunad flags `paused: "locked"` even on stopped, covered and source-gone rows.
  // Only a row whose effective status really is the lock pause gets the unlock
  // note; its waiting reason must not be replaced by the generic "Waiting" line.
  const pausedByLock = isPausedByLock(backup);
  const waiting = !pausedByLock && status.label === "Waiting" ? backupWaitingReason(backup) : null;
  const DestIcon = backup.kind === "cloud" ? Cloud : HardDrive;
  const dot = surface === "primary" ? "surface-secondary" : "surface-primary";
  return (
    <div
      data-slot="backup-item"
      className={cn(
        "rounded-large-element p-4 space-y-3",
        surface === "primary" ? "surface-primary" : "surface-secondary",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", dot)} aria-hidden="true" />
            <span className="text-xs font-mono">{backupKindLabel(backup)}</span>
          </div>
          <p className="text-xl font-mono font-normal leading-tight break-words">{backup.source_name}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          <Pill variant={status.variant}>{status.label}</Pill>
          {status.hint && <InfoHint content={status.hint} surface={surface} label="Why this backup is paused" />}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Pill>
          <DestIcon size={ICON_SIZE.xs} aria-hidden="true" />
          {backup.destination}
        </Pill>
        {backup.private && (
          <Pill>
            <Lock size={ICON_SIZE.xs} aria-hidden="true" />
            Private
          </Pill>
        )}
        <span>{lastCopyLine(backup)}</span>
      </div>

      {pausedByLock && <PausedByLockNote backup={backup} />}
      {waiting && <p className="text-sm break-words">{waiting}</p>}
      {backup.kind === "drive" && <BackupNotes notes={backup.notes} />}
      {note && <div className="text-sm space-y-1">{note}</div>}
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

BackupItem.propTypes = {
  backup: PropTypes.object.isRequired,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  note: PropTypes.node,
  children: PropTypes.node,
  className: PropTypes.string,
};
