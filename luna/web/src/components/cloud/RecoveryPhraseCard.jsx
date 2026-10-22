import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, KeyRound } from "lucide-react";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import CollapsibleSection from "@libreloom/ui/components/common/CollapsibleSection.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import SettingsRow from "@libreloom/ui/components/settings/SettingsRow.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { useOptionalAuth } from "../../context/AuthContext";
import { apiErrorMessage, deleteJson } from "../../lib/api";
import { createIdentity, getPhraseStatus, PHRASE_QUERY_KEY } from "../../lib/cloudPhrase";
import RecoveryPhraseCheck from "./RecoveryPhraseCheck.jsx";
import RecoveryPhraseSetup from "./RecoveryPhraseSetup.jsx";

/** Error line for a failed start: the icon carries the red, the words stay neutral text. */
function StartError({ children }) {
  return (
    <p role="alert" className="flex items-start gap-2 px-4 py-3 text-primary text-sm">
      <AlertCircle size={ICON_SIZE.sm} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function formatDate(unixSeconds, withYear = true) {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    ...(withYear ? { year: "numeric" } : {}),
    month: "long",
    day: "numeric",
  });
}

/** Status pill. The tint carries the state; the text stays neutral. */
function StatusPill({ tone, children }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-chip border-2 px-3 py-1 text-xs text-primary ${tone}`}
    >
      {children}
    </span>
  );
}

/**
 * Settings card for the cloud recovery phrase.
 * `dialog` is one of: null | {kind: "setup", replacing} | {kind: "check"} | {kind: "change"}.
 * `replacing` is true when a phrase already exists (Change, Get a new phrase).
 * Closing a dialog unmounts it, which drops any words and key material it held.
 */
export default function RecoveryPhraseCard() {
  const auth = useOptionalAuth();
  const userId = auth?.user?.id != null ? String(auth.user.id) : "";
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const { addToast } = useToast();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const deleteOldCopies = useMutation({
    mutationFn: () => deleteJson("/api/v1/private-backups/old-copies"),
    onSuccess: () => {
      setConfirmingDelete(false);
      setDeleteError("");
      addToast({ type: "success", message: "Backups made with your old phrase were deleted." });
      queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
    },
    onError: (err) => setDeleteError(apiErrorMessage(err, "Could not delete those backups. Try again.")),
  });

  const status = useQuery({
    queryKey: PHRASE_QUERY_KEY,
    queryFn: getPhraseStatus,
  });

  const close = () => setDialog(null);
  const lunaId = status.data?.luna_id ?? "";
  const signingPublic = status.data?.signing_public ?? "";
  const isSet = Boolean(status.data?.set);

  /**
   * A fresh Luna has no identity yet. Create it on demand, then keep the answer in
   * the status cache so the setup dialog can use it.
   */
  async function openSetup(replacing) {
    setStartError("");
    if (!lunaId) {
      setStarting(true);
      try {
        const created = await createIdentity();
        queryClient.setQueryData(PHRASE_QUERY_KEY, (/** @type {any} */ old) => ({
          ...(old || {}),
          luna_id: created.luna_id,
          signing_public: created.signing_public,
        }));
      } catch (err) {
        setStartError(apiErrorMessage(err, "Could not set up Luna's keys. Try again."));
        return;
      } finally {
        setStarting(false);
      }
    }
    setDialog({ kind: "setup", replacing });
  }

  const isMember = auth?.user?.role !== undefined && auth.user.role !== "admin";
  const oldCopies = status.data?.old_phrase_copies;
  const checkDue = Boolean(status.data?.check_due);

  let body;
  if (status.isPending) {
    body = <p className="px-4 py-3 text-primary text-sm">Checking your recovery phrase…</p>;
  } else if (status.isError) {
    body = <p className="px-4 py-3 text-primary text-sm">Could not load your recovery phrase. Try again later.</p>;
  } else if (!isSet) {
    body = (
      <>
        <SettingsRow
          stack
          label="Recovery phrase"
          description="Cloud backups of your files can start once you set one up."
          hideDivider={!startError}
        >
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill tone="bg-warning/20 border-warning/30">Not set up</StatusPill>
            <Button variant="primary" size="sm" disabled={!userId || starting} loading={starting} onClick={() => openSetup(false)}>
              Set up
            </Button>
          </div>
        </SettingsRow>
        {isMember && status.data?.admin_has_phrase === false && (
          <p className="px-4 pb-3 text-primary text-sm">Shared backups also wait for an Admin to set up theirs.</p>
        )}
        {startError && <StartError>{startError}</StartError>}
      </>
    );
  } else {
    const setOn = formatDate(status.data?.set_at);
    const checkedAt = status.data?.last_checked_at;
    const checked = checkedAt ? `Last checked ${formatDate(checkedAt, false)}` : "Not checked yet";
    body = (
      <>
        <SettingsRow stack label="Recovery phrase" description={`Set up on ${setOn} · ${checked}`}>
          <div className="flex flex-wrap items-center gap-2">
            {checkDue ? (
              <StatusPill tone="bg-warning/20 border-warning/30">Check due</StatusPill>
            ) : (
              <StatusPill tone="bg-success/20 border-success/30">Ready</StatusPill>
            )}
            <Button variant={checkDue ? "primary" : "outline"} size="sm" onClick={() => setDialog({ kind: "check" })}>
              Check my phrase
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!userId || starting}
              loading={starting}
              onClick={() => openSetup(true)}
            >
              Change phrase
            </Button>
          </div>
        </SettingsRow>
        {oldCopies?.count > 0 && (
          <SettingsRow
            stack
            label="Old phrase backups"
            description={`Backups made with your old phrase · removed on ${formatDate(oldCopies.removed_at, false)}`}
          >
            <Button variant="outline" size="sm" onClick={() => setConfirmingDelete(true)}>
              Delete now
            </Button>
          </SettingsRow>
        )}
        <div className="px-4 py-3">
          <CollapsibleSection title="Lost your recovery phrase?" surface="secondary">
            <p className="mb-3 text-primary text-sm">
              Get a new phrase without the old one. Your old phrase stops working for you, and backups sealed with it can then be opened only by others who have access to them.
            </p>
            <Button variant="accent" size="sm" disabled={!userId || starting} onClick={() => openSetup(true)}>
              Get a new phrase
            </Button>
          </CollapsibleSection>
        </div>
        {startError && <StartError>{startError}</StartError>}
      </>
    );
  }

  return (
    <>
      <SettingsCard
        icon={KeyRound}
        title="Recovery phrase"
        padding={false}
        headerActions={
          <InfoHint
            label="What the recovery phrase is"
            content="The 12 or 24 words that open your cloud backups. Luna never sees them."
          />
        }
      >
        {body}
      </SettingsCard>

      <ConfirmModal
        open={confirmingDelete}
        variant="danger"
        title="Delete backups made with your old phrase?"
        confirmLabel="Delete now"
        loading={deleteOldCopies.isPending}
        onClose={() => {
          setConfirmingDelete(false);
          setDeleteError("");
        }}
        onConfirm={() => deleteOldCopies.mutate()}
      >
        <p className="text-primary text-sm">
          These backups can only be opened with your old phrase. Deleting them removes them from the cloud for good. Backups made with your new phrase stay.
        </p>
        {deleteError && <p role="alert" className="mt-2 text-primary text-sm">{deleteError}</p>}
      </ConfirmModal>

      {dialog?.kind === "setup" && (
        <RecoveryPhraseSetup
          lunaId={lunaId}
          userId={userId}
          signingPublic={signingPublic}
          replacing={dialog.replacing}
          onClose={close}
          onSaved={() => queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY })}
        />
      )}
      {dialog?.kind === "check" && <RecoveryPhraseCheck lunaId={lunaId} onClose={close} />}
      {dialog?.kind === "change" && (
        <RecoveryPhraseCheck
          lunaId={lunaId}
          title="Enter your current phrase"
          intro="Enter your current recovery phrase first. Then you can set a new one."
          submitLabel="Continue"
          onClose={close}
          onVerified={() => setDialog({ kind: "setup", replacing: true })}
        />
      )}
    </>
  );
}
