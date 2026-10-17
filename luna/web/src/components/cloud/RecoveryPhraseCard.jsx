import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useOptionalAuth } from "../../context/AuthContext";
import { apiErrorMessage } from "../../lib/api";
import { getPhraseStatus, PHRASE_QUERY_KEY } from "../../lib/cloudPhrase";
import RecoveryPhraseCheck from "./RecoveryPhraseCheck.jsx";
import RecoveryPhraseSetup from "./RecoveryPhraseSetup.jsx";

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
 * `dialog` is one of: null | {kind: "setup"} | {kind: "check"} | {kind: "change"}
 * | {kind: "replace", oldEntropy}. Closing a dialog unmounts it, which drops any
 * words and key material it held.
 */
export default function RecoveryPhraseCard() {
  const auth = useOptionalAuth();
  const userId = auth?.user?.id != null ? String(auth.user.id) : "";
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState(null);

  const status = useQuery({
    queryKey: PHRASE_QUERY_KEY,
    queryFn: getPhraseStatus,
  });

  const close = () => setDialog(null);
  const lunaId = status.data?.luna_id ?? "";
  const isSet = Boolean(status.data?.set);

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
          Cloud backups are locked with 12 words only you know. Without them, nobody — not even an Admin — can open your cloud backups.
        </p>
        <Button
          variant="primary"
          size="sm"
          disabled={!userId || !lunaId}
          onClick={() => setDialog({ kind: "setup" })}
        >
          Set up
        </Button>
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
            disabled={!userId || !lunaId}
            onClick={() => setDialog({ kind: "change" })}
          >
            Change
          </Button>
        </div>
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
            content="12 words that lock your cloud backups. Luna never sees them. Write them down and keep them somewhere safe."
          />
        }
      >
        {body}
      </SettingsCard>

      {dialog?.kind === "setup" && (
        <RecoveryPhraseSetup
          lunaId={lunaId}
          userId={userId}
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
          onVerified={(oldEntropy) => setDialog({ kind: "replace", oldEntropy })}
        />
      )}
      {dialog?.kind === "replace" && (
        <RecoveryPhraseSetup
          lunaId={lunaId}
          userId={userId}
          oldEntropy={dialog.oldEntropy}
          onClose={close}
          onSaved={() => queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY })}
        />
      )}
    </>
  );
}
