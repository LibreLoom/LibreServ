import { useState } from "react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import { PhraseField } from "./RestoreForm.jsx";
import { apiErrorMessage } from "../../lib/api";
import { phraseToEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { checkPhrase, signFreshChallenge } from "../../lib/cloudPhrase";

/**
 * Asks for the recovery words (12 or 24) and proves them to Luna by signing a fresh challenge.
 * Without `onVerified` it shows the result inline ("Check my words").
 * With `onVerified` it hands the verified key material to the caller ("Change").
 */
export default function RecoveryPhraseCheck({
  lunaId,
  onClose,
  onVerified = null,
  title = "Check my words",
  intro = "Type your recovery words in order, with a space between each one.",
  submitLabel = "Check",
}) {
  const [words, setWords] = useState("");
  const [error, setError] = useState("");
  const [matched, setMatched] = useState(false);
  const [checking, setChecking] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setMatched(false);
    let entropy;
    try {
      entropy = phraseToEntropy(words);
    } catch (err) {
      setError(err.message);
      return;
    }
    setChecking(true);
    try {
      const signature = await signFreshChallenge(entropy, lunaId);
      await checkPhrase(signature);
      if (onVerified) {
        onVerified(entropy);
      } else {
        setMatched(true);
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Could not check your words. Try again."));
    } finally {
      setChecking(false);
    }
  }

  return (
    <ModalCard open title={title} onClose={onClose} size="md">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-primary text-sm">{intro}</p>
        <PhraseField value={words} onChange={setWords} label="Your recovery words" />
        {error && <PageNotice variant="error">{error}</PageNotice>}
        {matched && <PageNotice variant="info" surface="primary">Your words match your recovery phrase.</PageNotice>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="sm" loading={checking} disabled={checking || !words.trim()}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </ModalCard>
  );
}
