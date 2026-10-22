import { useRef, useState } from "react";
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
import { movingPercent } from "../../lib/movingPercent.js";
import {
  checkPhraseWords,
  createIdentity,
  getPhraseStatus,
  PHRASE_QUERY_KEY,
  replaceErrorMessage,
  replacePhrase,
} from "../../lib/cloudPhrase";
import PhraseReplaceFlow from "./PhraseReplaceFlow.jsx";
import RecoveryPhraseCheck from "./RecoveryPhraseCheck.jsx";
import RecoveryPhraseSetup from "./RecoveryPhraseSetup.jsx";

/** How often the card asks for status while Luna re-seals backups to the new phrase. */
const RESEAL_POLL_MS = 5000;

/**
 * Neutral status for backups moving to a new phrase. Hidden when `moving` is null.
 * When Connect storage is full it adds what happened and what to do, inline (no toast).
 */
export function MovingNote({ moving, className = "" }) {
  if (!moving) return null;
  return (
    <div className={`space-y-1 text-sm ${className}`}>
      <p>{`Moving to your new phrase · ${movingPercent(moving)}%`}</p>
      {moving.paused_full && (
        <p>
          Connect storage is full, so the move is paused. Nothing old was deleted. Free up space or add storage on Luna Connect to continue.
        </p>
      )}
    </div>
  );
}

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
 * `dialog` is one of: null | {kind: "setup"} | {kind: "check"} | {kind: "change"} | {kind: "lost"}.
 * "change" and "lost" open PhraseReplaceFlow. Closing a dialog unmounts it, which drops any
 * words and key material it held. The old phrase's key and the Luna password are kept in
 * `secrets` (a ref, never state, storage or the query cache) only while a replacement is open.
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
  const [replaceError, setReplaceError] = useState("");
  const secrets = useRef({ oldEntropy: null, password: "" });

  const replace = useMutation({
    mutationFn: (/** @type {any} */ vars) =>
      replacePhrase({ proof: vars.proof, exposed: vars.exposed, newPhrase: vars.newPhrase, lunaId, userId, signingPublic }),
    onSuccess: (_data, { kind }) => {
      addToast({
        type: "success",
        message: kind === "change" ? "Recovery phrase changed." : "New recovery phrase saved.",
      });
      closeReplace();
      queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY });
    },
    // Refused or failed: the message stays inline in the open dialog, with no toast and no retry.
    onError: (err, { proof }) => setReplaceError(replaceErrorMessage(err, "oldEntropy" in proof ? "old" : "password")),
  });

  const status = useQuery({
    queryKey: PHRASE_QUERY_KEY,
    queryFn: getPhraseStatus,
    // Poll only while Luna is re-sealing; stop as soon as status says it is done.
    refetchInterval: (query) => (query.state.data?.resealing ? RESEAL_POLL_MS : false),
  });

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


  const close = () => {
    setDialog(null);
    queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY });
  };
  const lunaId = status.data?.luna_id ?? "";
  const signingPublic = status.data?.signing_public ?? "";
  const isSet = Boolean(status.data?.set);

  function closeReplace() {
    secrets.current = { oldEntropy: null, password: "" };
    setReplaceError("");
    setDialog(null);
  }

  /** Answer to "Check my phrase" in the change flow: refused phrases stop here; a good one is kept in memory for the save. */
  async function proveOldPhrase(phrase) {
    const entropy = await checkPhraseWords(phrase, lunaId);
    if (!entropy) return false;
    secrets.current.oldEntropy = entropy;
    return true;
  }

  /** The lost flow's password is only checked when the save goes through, so it is kept for that call. */
  function proveLost({ password }) {
    secrets.current.password = password;
    return true;
  }

  function saveReplace({ exposed, newPhrase }) {
    const kind = dialog?.kind;
    const oldEntropy = secrets.current.oldEntropy;
    if (kind === "change" && !oldEntropy) {
      setReplaceError("Enter your current phrase again, then try once more.");
      return;
    }
    const proof = kind === "change" ? { oldEntropy } : { password: secrets.current.password };
    setReplaceError("");
    replace.mutate({ kind, proof, exposed, newPhrase });
  }

  /**
   * A fresh Luna has no identity yet. Create it on demand, then keep the answer in
   * the status cache so the setup dialog can use it.
   */
  async function openSetup() {
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
    setDialog({ kind: "setup" });
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
            <Button variant="primary" size="sm" disabled={!userId || starting} loading={starting} onClick={() => openSetup()}>
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
              disabled={!userId || !lunaId}
              onClick={() => setDialog({ kind: "change" })}
            >
              Change phrase
            </Button>
          </div>
          <MovingNote moving={status.data?.moving} className="mt-3 text-primary" />
          {status.data?.resealing && (
            <p className="mt-3 text-primary text-sm">Updating your cloud backups to the new phrase…</p>
          )}
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
              Get a new phrase without the old one. Private items backed up with the old phrase can't be opened anymore. Your shared cloud backups stay open to you.
            </p>
            <Button variant="accent" size="sm" disabled={!userId || !lunaId} onClick={() => setDialog({ kind: "lost" })}>
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
          onClose={close}
          onSaved={() => queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY })}
        />
      )}
      {dialog?.kind === "check" && (
        <RecoveryPhraseCheck
          verify={(phrase) => checkPhraseWords(phrase, lunaId).then(Boolean)}
          onClose={close}
        />
      )}
      {(dialog?.kind === "change" || dialog?.kind === "lost") && (
        <PhraseReplaceFlow
          kind={dialog.kind}
          onClose={closeReplace}
          onProve={(proof) => ("phrase" in proof ? proveOldPhrase(proof.phrase) : proveLost(proof))}
          onSave={saveReplace}
          busy={replace.isPending}
          error={replaceError}
        />
      )}
    </>
  );
}
