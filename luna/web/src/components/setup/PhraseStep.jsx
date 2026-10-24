import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { AlertCircle } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { apiErrorMessage } from "../../lib/api";
import { buildPhraseBody, createIdentity, savePhrase } from "../../lib/cloudPhrase";
import { useAuth } from "../../context/AuthContext";
import PhraseWriteDown from "../cloud/PhraseWriteDown.jsx";

/**
 * Setup step: make Luna's keys, show a new recovery phrase to write down, confirm three words, save.
 * Content only (SetupPage draws the card around it). `onSaved` runs once Luna has the phrase.
 * The phrase is never stored in the setup progress; only the browser holds it until it is saved.
 * PhraseGate reuses it with its own label, headings and opening line.
 * @param {{
 *   onSaved: () => unknown,
 *   saveLabel?: string,
 *   titles?: { show?: string, confirm?: string },
 *   intro?: import("react").ReactNode,
 * }} props
 */
export default function PhraseStep({
  onSaved,
  saveLabel = "Save and continue",
  titles = undefined,
  intro = undefined,
}) {
  const { user } = useAuth();
  const userId = user?.id != null ? String(user.id) : "";
  const [identity, setIdentity] = useState(
    /** @type {{ luna_id: string, signing_public: string } | null} */ (null),
  );
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Once Luna has the phrase, a second try only moves on; sending it again would be refused.
  const savedRef = useRef(false);

  // The keys are made from Luna's id, so Luna makes its id before the phrase is shown.
  useEffect(() => {
    let alive = true;
    createIdentity()
      .then((created) => {
        if (alive) setIdentity(created);
      })
      .catch((err) => {
        if (alive) setError(apiErrorMessage(err, "Could not set up your recovery phrase. Try again."));
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setError("");
    setAttempt((n) => n + 1);
  }, []);

  async function save(/** @type {Uint8Array} */ entropy) {
    if (!identity) return;
    if (!savedRef.current) {
      await savePhrase(
        buildPhraseBody(entropy, { lunaId: identity.luna_id, userId, signingPublic: identity.signing_public }),
      );
      savedRef.current = true;
    }
    await onSaved();
  }

  if (error) {
    return (
      <div className="space-y-4">
        <p role="alert" className="flex items-start gap-2 text-sm text-primary">
          <AlertCircle size={ICON_SIZE.sm} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
          <span>{error}</span>
        </p>
        <Button variant="primary" size="sm" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }

  if (!identity || !userId) {
    return (
      <p role="status" className="text-primary text-sm">
        Making your recovery phrase…
      </p>
    );
  }

  return <PhraseWriteDown surface="secondary" onSave={save} saveLabel={saveLabel} titles={titles} intro={intro} />;
}

PhraseStep.propTypes = {
  onSaved: PropTypes.func.isRequired,
  saveLabel: PropTypes.string,
  titles: PropTypes.shape({ show: PropTypes.string, confirm: PropTypes.string }),
  intro: PropTypes.node,
};
