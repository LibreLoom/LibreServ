import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { apiErrorMessage } from "../../lib/api";
import { entropyToPhrase, newEntropy } from "../../lib/backupCrypto";
import { buildPhraseBody, PHRASE_QUERY_KEY, savePhrase, signFreshChallenge } from "../../lib/cloudPhrase";

/** Three distinct word positions (0-based), sorted, picked at random. */
function pickCheckPositions() {
  const positions = new Set();
  while (positions.size < 3) positions.add(Math.floor(Math.random() * 12));
  return [...positions].sort((a, b) => a - b);
}

/**
 * Shows 12 new words, asks for three of them back, then saves the phrase.
 * `oldEntropy` is set when replacing a phrase: the save is then signed with the
 * old phrase. The words live only in this component's state.
 */
export default function RecoveryPhraseSetup({ lunaId, userId, oldEntropy = null, onClose, onSaved = null }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [entropy] = useState(() => newEntropy());
  const [words] = useState(() => entropyToPhrase(entropy).split(" "));
  const [step, setStep] = useState("show");
  const [positions] = useState(pickCheckPositions);
  const [answers, setAnswers] = useState(["", "", ""]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const title = oldEntropy ? "Change your recovery phrase" : "Set up your recovery phrase";

  async function copyWords() {
    try {
      await navigator.clipboard.writeText(words.join(" "));
      setCopied(true);
    } catch {
      setError("Could not copy. Select the words and copy them by hand.");
    }
  }

  function setAnswer(index, value) {
    setAnswers((prev) => prev.map((v, i) => (i === index ? value : v)));
  }

  async function save(event) {
    event.preventDefault();
    setError("");
    const wrong = positions.findIndex((pos, i) => answers[i].trim().toLowerCase() !== words[pos]);
    if (wrong !== -1) {
      setError(`Word ${positions[wrong] + 1} doesn't match. Check your list and try again.`);
      return;
    }
    setSaving(true);
    try {
      // A replacement must be signed by the old phrase, with a challenge fetched just now.
      const signature = oldEntropy ? await signFreshChallenge(oldEntropy, lunaId) : undefined;
      await savePhrase(buildPhraseBody(entropy, { lunaId, userId, signature }));
      await queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY });
      addToast({ type: "success", message: oldEntropy ? "Recovery phrase changed." : "Recovery phrase saved." });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not save your recovery phrase. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalCard open title={title} onClose={onClose} size="md">
      {step === "show" ? (
        <div className="space-y-4">
          <p className="text-primary text-sm">
            Write these 12 words down in order and keep them somewhere safe. Anyone with them can open your cloud backups.
          </p>
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {words.map((word, i) => (
              <li key={i} className="flex items-center gap-2 text-primary text-sm">
                <span className="w-6 text-right text-primary">{i + 1}.</span>
                <InlinePill>{word}</InlinePill>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={copyWords}>
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="primary" size="sm" onClick={() => setStep("confirm")}>
              I wrote them down
            </Button>
          </div>
          {error && <p role="alert" className="text-error text-sm">{error}</p>}
        </div>
      ) : (
        <form onSubmit={save} className="space-y-4">
          <p className="text-primary text-sm">Type these words from your list to confirm you wrote them down.</p>
          {positions.map((pos, i) => (
            <label key={pos} className="block space-y-1">
              <span className="text-primary text-sm">Word {pos + 1}</span>
              <input
                type="text"
                value={answers[i]}
                onChange={(e) => setAnswer(i, e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="w-full rounded-pill border border-primary/30 bg-transparent px-4 py-2 text-primary text-sm outline-none focus:border-accent"
              />
            </label>
          ))}
          {error && <p role="alert" className="text-error text-sm">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => { setError(""); setStep("show"); }} disabled={saving}>
              Back to the words
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={saving} disabled={saving}>
              Save recovery phrase
            </Button>
          </div>
        </form>
      )}
    </ModalCard>
  );
}
