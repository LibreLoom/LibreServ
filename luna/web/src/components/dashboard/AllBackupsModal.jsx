import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { apiErrorMessage, deleteJson, getJson } from "../../lib/api";
import {
  backupStatus,
  groupByCreator,
  lastGoodCopyLine,
  needsALook,
  privateGroups,
} from "../../lib/backupRows.js";
import { useAuth } from "../../context/AuthContext.jsx";
import ProtectSheet from "../files/ProtectSheet.jsx";

const CONNECT_BACKUPS_URL = "https://connect.luna.libreloom.org/backups";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "needs", label: "Needs a look" },
  { value: "cloud", label: "Cloud" },
  { value: "drives", label: "Drives" },
];

function filterBackups(list, filter) {
  if (filter === "needs") return list.filter(needsALook);
  if (filter === "cloud") return list.filter((b) => b.kind === "cloud");
  if (filter === "drives") return list.filter((b) => b.kind === "drive");
  return list;
}

const linkClass =
  "text-secondary underline decoration-accent underline-offset-4 rounded-pill focus-visible:ring-2 focus-visible:ring-accent outline-none";

/** Link line for a backup whose copies live somewhere else (stopped or source gone). */
function CopiesLink({ backup }) {
  if (backup.kind === "cloud") {
    return (
      <p className="text-sm">
        <a
          href={CONNECT_BACKUPS_URL}
          target="_blank"
          rel="noreferrer"
          className={linkClass}
          onClick={() => haptic("selection")}
        >
          Open Luna Connect
        </a>
      </p>
    );
  }
  return (
    <p className="text-sm">
      <Link
        to={`/drives/${backup.target_drive}?backups=1`}
        className={linkClass}
        onClick={() => haptic("selection")}
      >
        Open the Backups folder on <InlinePill>{backup.destination || backup.target_drive_name}</InlinePill>
      </Link>
    </p>
  );
}

function BackupRow({ backup, onOpen }) {
  const status = backupStatus(backup);
  const active = backup.status === "active";
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium min-w-0 break-words">{backup.source_name}</span>
        {backup.private && <Pill>Private</Pill>}
        <Pill variant={status.variant}>{status.label}</Pill>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Pill>{backup.destination}</Pill>
        <span>{lastGoodCopyLine(backup)}</span>
      </div>
      {!active && backup.stop_reason && <p className="text-sm">{backup.stop_reason}</p>}
      {!active && backup.kind === "drive" && (
        <p className="text-sm">
          Copies are in the Backups folder on <InlinePill>{backup.target_drive_name}</InlinePill>
        </p>
      )}
      {!active && <CopiesLink backup={backup} />}
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

/** One row per owner's private items: a combined status, never item names. */
function PrivateItemsRow({ owner, isYours, isAdmin, onRemove }) {
  const title = owner.deleted ? "Private items · deleted user" : "Private items";
  let line = null;
  if (isYours) line = "Yours. Open a private folder's shield to see each one.";
  else if (!owner.deleted) line = `Only ${owner.name} can see these.`;
  const needing = owner.needsLook;
  const status =
    needing === 0
      ? { label: "All backed up", variant: "success" }
      : { label: needing === 1 ? "1 needs a look" : `${needing} need a look`, variant: "warning" };
  return (
    <li>
      <div className="surface-primary rounded-large-element p-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium min-w-0 break-words">{title}</span>
          <Pill variant={status.variant}>{status.label}</Pill>
        </div>
        {line && <p className="text-sm">{line}</p>}
        {owner.deleted && isAdmin && (
          <div>
            <Button variant="accent" surface="primary" onClick={() => onRemove(owner)}>
              Remove
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Every backup Luna knows about, grouped by who made it, plus one private items row per owner.
 * @param {{ open: boolean, onClose: () => void, backups: any[] }} props
 */
export default function AllBackupsModal({ open, onClose, backups = [] }) {
  const [filter, setFilter] = useState("all");
  const [sheet, setSheet] = useState(null);
  const [removing, setRemoving] = useState(null);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const queryClient = useQueryClient();
  const toast = useToast();
  // Members may not be allowed to list users; then names fall back to "Someone".
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => getJson("/api/v1/users"),
    retry: false,
  });
  // Private items are a summary only; a member may not get it, so it stays quiet then.
  const summary = useQuery({
    queryKey: ["private-backups-summary"],
    queryFn: () => getJson("/api/v1/private-backups/summary"),
    retry: false,
  });
  const owners = privateGroups(summary.data, users.data);

  const remove = useMutation({
    mutationFn: (ownerId) => deleteJson(`/api/v1/private-backups/owners/${ownerId}`),
    onSuccess: (res) => {
      const n = res?.removed ?? 0;
      toast.addToast({
        type: "success",
        message: `Removed ${n} ${n === 1 ? "backup" : "backups"}`,
      });
      queryClient.invalidateQueries({ queryKey: ["private-backups-summary"] });
      queryClient.invalidateQueries({ queryKey: ["backups"] });
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
    },
    onError: (err) => {
      toast.addToast({
        type: "error",
        message: "Could not remove the backups",
        description: apiErrorMessage(err, "Try again in a moment."),
      });
    },
  });

  // Sections by creator; each owner's private items row joins the section of its owner.
  const sections = groupByCreator(filterBackups(backups, filter), users.data).map((g) => ({
    ...g,
    ownerId: g.items[0]?.created_by,
    privateOwner: null,
  }));
  for (const owner of owners) {
    const shown = filter === "all" || (filter === "needs" && owner.needsLook > 0);
    if (!shown) continue;
    const section = sections.find((s) => s.ownerId === owner.ownerId);
    if (section) section.privateOwner = owner;
    else
      sections.push({
        name: owner.name || "Deleted user",
        ownerId: owner.ownerId,
        items: [],
        privateOwner: owner,
      });
  }
  const isYours = (ownerId) => !!user && ownerId === user.id;

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
          {sections.length === 0 && (
            <p>
              {backups.length === 0 && owners.length === 0
                ? "No backups yet."
                : "No backups match this filter."}
            </p>
          )}
          {sections.map((group) => (
            <section key={group.ownerId ?? group.name} className="flex flex-col gap-2">
              <h3 className="text-base">{group.name}</h3>
              <ul className="flex flex-col gap-2">
                {group.privateOwner && (
                  <PrivateItemsRow
                    owner={group.privateOwner}
                    isYours={isYours(group.privateOwner.ownerId)}
                    isAdmin={isAdmin}
                    onRemove={setRemoving}
                  />
                )}
                {group.items.map((b) => (
                  <BackupRow key={b.id} backup={b} onOpen={setSheet} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </ModalCard>
      <ConfirmModal
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const owner = removing;
          setRemoving(null);
          remove.mutate(owner.ownerId);
        }}
        title="Remove a deleted user's private backups?"
        variant="danger"
        confirmLabel="Remove backups"
      >
        <p>Removes every backup of their private items, on drives and in the cloud.</p>
      </ConfirmModal>
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
