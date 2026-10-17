import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { apiErrorMessage } from "../../lib/api";
import { entropyToPhrase, newEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { buildPhraseBody, PHRASE_QUERY_KEY, savePhrase } from "../../lib/cloudPhrase";

/** Three distinct word positions (0-based), sorted, picked at random. */
function pickCheckPositions() {
  const positions = new Set();
  while (positions.size < 3) positions.add(Math.floor(Math.random() * 12));
  return [...positions].sort((a, b) => a - b);
}

/** Error line: the icon carries the red, the words stay neutral text. */
function ErrorNotice({ children }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-primary text-sm">
      <AlertCircle size={ICON_SIZE.sm} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/**
 * Shows 12 new words, asks for three of them back, then saves the phrase.
 * `signingPublic` is Luna's signing public key (base64) from the status call.
 * `replacing` is set when a phrase already exists; the old phrase is not needed.
 * The words live only in this component's state.
 */
export default function RecoveryPhraseSetup({
  lunaId,
  userId,
  signingPublic,
  replacing = false,
  onClose,
  onSaved = null,
}) {
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

  const title = replacing ? "Set a new recovery phrase" : "Set up your recovery phrase";

  async function copyWords() {
    try {
      await navigator.clipboard.writeText(words.join(" "));
      setCopied(true);
    } catch {
      setError("Could not copy. Select the words and copy them by hand.");
    }
  }

  function printWords() {
    const win = window.open("", "_blank");
    if (!win) {
      setError("Could not open the print window. Allow pop-ups for Luna, or use Download.");
      return;
    }
    const items = words.map((word, i) => `<li>${i + 1}. ${word}</li>`).join("");
    win.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>Luna recovery phrase</title></head>` +
        `<body><h1>Luna recovery phrase</h1><ol>${items}</ol>` +
        `<p>Keep these 12 words somewhere safe. Anyone with them can open your cloud backups.</p></body></html>`,
    );
    win.document.close();
    win.focus();
    win.print();
  }

  function downloadWords() {
    const lines = words.map((word, i) => `${i + 1}. ${word}`).join("\n");
    const text =
      `Luna recovery phrase\n\n${lines}\n\n` +
      "Keep these 12 words somewhere safe. Anyone with them can open your cloud backups.\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "luna-recovery-phrase.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
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
      // Luna's signing public key is sealed into the save, so Connect cannot swap it.
      await savePhrase(buildPhraseBody(entropy, { lunaId, userId, signingPublic }));
      await queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY });
      addToast({ type: "success", message: replacing ? "Recovery phrase changed." : "Recovery phrase saved." });
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
          <p className="text-primary text-sm">
            If you lose it, no one can open your cloud backups for you, including us.
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
            <Button variant="outline" size="sm" onClick={printWords}>
              Print
            </Button>
            <Button variant="outline" size="sm" onClick={downloadWords}>
              Download
            </Button>
            <Button variant="primary" size="sm" onClick={() => setStep("confirm")}>
              I wrote them down
            </Button>
          </div>
          {error && <ErrorNotice>{error}</ErrorNotice>}
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
                className="w-full rounded-pill border border-secondary bg-transparent px-4 py-2 text-primary text-sm outline-none focus:border-accent"
              />
            </label>
          ))}
          {error && <ErrorNotice>{error}</ErrorNotice>}
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
