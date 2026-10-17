import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, KeyRound } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { useOptionalAuth } from "../../context/AuthContext";
import { apiErrorMessage } from "../../lib/api";
import { createIdentity, getPhraseStatus, PHRASE_QUERY_KEY } from "../../lib/cloudPhrase";
import RecoveryPhraseCheck from "./RecoveryPhraseCheck.jsx";
import RecoveryPhraseSetup from "./RecoveryPhraseSetup.jsx";

/** Error line for a failed start: the icon carries the red, the words stay neutral text. */
function StartError({ children }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-primary text-sm">
      <AlertCircle size={ICON_SIZE.sm} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function formatSetAt(unixSeconds) {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
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

  let body;
  if (status.isPending) {
    body = <p className="text-primary text-sm">Checking your recovery phrase…</p>;
  } else if (status.isError) {
    body = (
      <p className="text-primary text-sm">
        {apiErrorMessage(status.error, "Could not load your recovery phrase status. Try again later.")}
      </p>
    );
  } else if (!isSet) {
    body = (
      <div className="space-y-3">
        <p className="text-primary text-sm">
          Recovery phrase: <span>Not set</span>
        </p>
        <p className="text-primary text-sm">
          Cloud backups are locked with 12 words only you know. Only people with a recovery phrase for that backup can open it.
        </p>
        <Button variant="primary" size="sm" disabled={!userId || starting} loading={starting} onClick={() => openSetup(false)}>
          Set up
        </Button>
        {startError && <StartError>{startError}</StartError>}
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-primary text-sm">
          Recovery phrase: <span>Set on {formatSetAt(status.data?.set_at)}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "check" })}>
            Check my words
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!userId || starting}
            loading={starting}
            onClick={() => openSetup(true)}
          >
            Change
          </Button>
        </div>
        <div className="space-y-2">
          <p className="text-primary text-sm">
            Lost your 12 words? Get a new phrase without the old one. Your old phrase stops working for you, and backups sealed with it can then be opened only by others who have access to them.
          </p>
          <Button variant="outline" size="sm" disabled={!userId || starting} onClick={() => openSetup(true)}>
            Get a new phrase
          </Button>
        </div>
        {startError && <StartError>{startError}</StartError>}
      </div>
    );
  }

  return (
    <>
      <SettingsCard
        icon={KeyRound}
        title="Recovery phrase"
        headerActions={
          <InfoHint
            label="What the recovery phrase is"
            content="12 words that open your cloud backups."
          />
        }
      >
        {body}
      </SettingsCard>

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
          title="Enter your current words"
          intro="Enter your current 12 words first. Then you can set new ones."
          submitLabel="Continue"
          onClose={close}
          onVerified={() => setDialog({ kind: "setup", replacing: true })}
        />
      )}
    </>
  );
}
