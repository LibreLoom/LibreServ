import { useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { useQueryClient } from "@tanstack/react-query";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { useAuth } from "../../context/AuthContext";
import { PHRASE_QUERY_KEY } from "../../lib/cloudPhrase";
import PhraseStep from "../setup/PhraseStep.jsx";

/** The full page an account sees until it has a recovery phrase. */
function PhraseGateScreen() {
  const { refresh, logout } = useAuth();
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  async function saved() {
    addToast({ type: "success", message: "Recovery phrase saved." });
    queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY });
    // The account now reports a phrase, so the gate lets the app through.
    await refresh();
  }

  return (
    <main data-slot="phrase-gate" className="flex min-h-screen items-center justify-center surface-primary px-4 py-12">
      <div className="w-full max-w-md space-y-6 rounded-large-element surface-secondary p-8">
        <div className="space-y-2">
          <h1 className="font-mono font-normal text-2xl text-primary">Set up your recovery phrase</h1>
          <p className="text-primary text-sm">
            Every account on this Luna has its own recovery phrase. It locks your cloud backups so only you can open them.
          </p>
        </div>
        <PhraseStep
          onSaved={saved}
          saveLabel="Save recovery phrase"
          titles={{ show: "", confirm: "Confirm your recovery phrase" }}
          intro={null}
        />
        <div className="flex justify-end">
          <Button variant="ghost" surface="secondary" size="sm" onClick={() => logout()}>
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}

/**
 * Keeps an account without a recovery phrase out of the app. Only a clear `phrase_set: false` from
 * Luna blocks; a missing value (older replies, a failed read) lets the app through while it re-reads once.
 */
export default function PhraseGate({ children }) {
  const { user, refresh } = useAuth();
  // Signing in returns the account without `phrase_set`. Read it once from /auth/me so a fresh
  // sign-in can't skip the phrase screen. The app shows meanwhile, as it does when Luna doesn't say.
  const askedFor = useRef(null);
  const unknown = Boolean(user) && user.phrase_set === undefined;
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!unknown || askedFor.current === userId) return;
    askedFor.current = userId;
    refresh?.();
  }, [unknown, userId, refresh]);
  if (user?.phrase_set === false) return <PhraseGateScreen />;
  return children;
}

PhraseGate.propTypes = {
  children: PropTypes.node,
};
