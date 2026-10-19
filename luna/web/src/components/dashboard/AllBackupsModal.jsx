import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Shield } from "lucide-react";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { apiErrorMessage, deleteJson, getJson } from "../../lib/api";
import {
  groupByCreator,
  needsALook,
  privateGroups,
} from "../../lib/backupRows.js";
import { useAuth } from "../../context/AuthContext.jsx";
import BackupItem from "../protect/BackupItem.jsx";
import ProtectSheet from "../files/ProtectSheet.jsx";
import { BACKUPS_PATH, folderHref } from "../../lib/paths.js";

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

/** Where the copies of a stopped backup live, as a link. */
function CopiesLink({ backup }) {
  if (backup.kind === "cloud") {
    return (
      <a
        href={CONNECT_BACKUPS_URL}
        target="_blank"
        rel="noreferrer"
        className={linkClass}
        onClick={() => haptic("selection")}
      >
        Open Luna Connect
      </a>
    );
  }
  return (
    <Link
      to={folderHref(backup.target_drive, BACKUPS_PATH)}
      className={linkClass}
      onClick={() => haptic("selection")}
    >
      Open the Backups folder on <InlinePill>{backup.destination || backup.target_drive_name}</InlinePill>
    </Link>
  );
}

function BackupRow({ backup, onOpen }) {
  const active = backup.status === "active";
  return (
    <li>
      <BackupItem
        backup={backup}
        surface="primary"
        note={
          !active && (
            <>
              {backup.stop_reason && <p>{backup.stop_reason}</p>}
              <p>
                <CopiesLink backup={backup} />
              </p>
            </>
          )
        }
      >
        {active && (
          <Button
            variant="outline"
            surface="primary"
            size="sm"
            aria-label={`Open protection for ${backup.source_name}`}
            onClick={() => onOpen(backup)}
          >
            Open
          </Button>
        )}
      </BackupItem>
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
      <div className="surface-primary rounded-large-element p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="flex items-center gap-2 text-xl font-mono font-normal leading-tight break-words">
              <Lock size={ICON_SIZE.md} className="shrink-0" aria-hidden="true" />
              {title}
            </p>
          </div>
          <Pill variant={/** @type {any} */ (status.variant)} className="shrink-0">
            {status.label}
          </Pill>
        </div>
        {line && <p className="text-sm">{line}</p>}
        {owner.deleted && isAdmin && (
          <div>
            <Button variant="accent" surface="primary" size="sm" onClick={() => onRemove(owner)}>
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
          {sections.length === 0 &&
            (backups.length === 0 && owners.length === 0 ? (
              <EmptyState
                surface="primary"
                icon={Shield}
                title="No backups yet"
                description="Click the shield icon beside a drive or folder to back it up."
              />
            ) : (
              <EmptyState
                surface="primary"
                icon={Shield}
                title="Nothing matched"
                description="No backups fit this filter. Try another one."
              />
            ))}
          {sections.map((group) => (
            <section key={group.ownerId ?? group.name} className="flex flex-col gap-3">
              <h3 className="text-sm font-mono">{isYours(group.ownerId) ? "You" : group.name}</h3>
              <ul className="flex flex-col gap-3">
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
