import { useState } from "react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import { apiErrorMessage } from "../../lib/api";
import { phraseToEntropy } from "../../lib/backupCrypto";
import { checkPhrase, signFreshChallenge } from "../../lib/cloudPhrase";

/**
 * Asks for the 12 words and proves them to Luna by signing a fresh challenge.
 * Without `onVerified` it shows the result inline ("Check my words").
 * With `onVerified` it hands the verified key material to the caller ("Change").
 */
export default function RecoveryPhraseCheck({
  lunaId,
  onClose,
  onVerified = null,
  title = "Check my words",
  intro = "Type your 12 words in order, with a space between each one.",
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
        <label className="block space-y-1">
          <span className="text-primary text-sm">Your 12 words</span>
          <textarea
            value={words}
            onChange={(e) => setWords(e.target.value)}
            rows={3}
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-large-element border border-primary/30 bg-transparent p-3 text-primary text-sm outline-none focus:border-accent"
          />
        </label>
        {error && <p role="alert" className="text-error text-sm">{error}</p>}
        {matched && <p role="status" className="text-primary text-sm">Your words match your recovery phrase.</p>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="sm" loading={checking} disabled={checking || !words.trim()}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </ModalCard>
  );
}
