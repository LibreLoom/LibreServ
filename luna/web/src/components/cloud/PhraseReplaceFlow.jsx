import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import CardButton from "@libreloom/ui/components/ui/CardButton.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { entropyToPhrase, newEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { shakeElement } from "@libreloom/ui/utils/shake.js";
import RecoveryPhraseCheck from "./RecoveryPhraseCheck.jsx";

const LENGTH_OPTIONS = [
  { value: "12", label: "12 words" },
  { value: "24", label: "24 words" },
];

const MAY_HAVE_IT =
  "Your old phrase stops working right away. Luna then moves your cloud backups to the new phrase in the background, which can take days. Until it finishes, someone who already used your old phrase could still open files that haven't changed.";
const CONNECT_NOTE =
  "Your old phrase alone does not open backups on Connect. That also takes your Connect sign-in or a share link.";

/** Private-history lines for the lost flow (plan 4.3): without the old phrase, Luna can't keep them. */
const LOST_PRIVATE_LINES = {
  safe: "Luna keeps your older private items for 30 days in case you find your phrase, then removes them.",
  exposed: "Luna removes your older private items now.",
};

function pickPositions(count) {
  const positions = new Set();
  while (positions.size < 3) positions.add(Math.floor(Math.random() * count));
  return [...positions].sort((a, b) => a - b);
}

function positionsSentence(positions) {
  const nums = positions.map((p) => p + 1);
  return `words ${nums.slice(0, -1).join(", ")} and ${nums[nums.length - 1]}`;
}

/** One answer to "Could someone else have your phrase?": the button, then what it does. */
function Answer({ label, lines, onPick, disabled = false }) {
  return (
    <div className="space-y-2">
      <CardButton actionLabel={label} className="mt-0 py-4" onClick={disabled ? undefined : onPick}>{label}</CardButton>
      {lines.map((line) => (
        <p key={line} className="text-primary text-sm">{line}</p>
      ))}
    </div>
  );
}

Answer.propTypes = {
  label: PropTypes.string.isRequired,
  lines: PropTypes.arrayOf(PropTypes.string).isRequired,
  onPick: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
};

/**
 * Replaces a recovery phrase. Props only: the caller proves, signs and saves.
 * change: check the old phrase, ask the question, show and confirm the new phrase, save.
 * lost: say what is lost, ask the question, ask for the Luna password, new phrase, save.
 * `onProve(proof)` gets `{ phrase }` (change) or `{ password }` (lost) and may resolve false
 * to refuse it; `error` is the caller's inline message (wrong password, locked out, save failed).
 * The new phrase and the password live only in this component's state.
 * After a saved change with "Someone may have it" the caller sets `saved`, and the flow ends with
 * the optional "Delete older private versions" step: `onRetire()` deletes, `onClose` skips.
 * `retireError` is that step's inline message; the caller owns the call and the success toast.
 */
export default function PhraseReplaceFlow({
  kind,
  open = true,
  onClose,
  onProve,
  onSave,
  busy = false,
  error = "",
  saved = false,
  onRetire = () => {},
  retiring = false,
  retireError = "",
}) {
  const lost = kind === "lost";
  const [step, setStep] = useState(lost ? "warn" : "check");
  const [exposed, setExposed] = useState(false);
  const [password, setPassword] = useState("");
  const [proving, setProving] = useState(false);
  const [localError, setLocalError] = useState("");
  const [entropy, setEntropy] = useState(null);
  const [positions, setPositions] = useState([0, 1, 2]);
  const [answers, setAnswers] = useState(["", "", ""]);
  const [copied, setCopied] = useState(false);
  const formRef = useRef(null);

  // Wipe everything secret when the dialog closes.
  useEffect(() => {
    if (open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- clear secret state on close */
    setStep(lost ? "warn" : "check");
    setPassword("");
    setEntropy(null);
    setAnswers(["", "", ""]);
    setExposed(false);
    setLocalError("");
    setCopied(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, lost]);

  const words = useMemo(() => (entropy ? entropyToPhrase(entropy).split(" ") : []), [entropy]);
  const privateLine = lost ? LOST_PRIVATE_LINES : null;
  const shownError = localError || error;

  function fail(message) {
    setLocalError(message);
    shakeElement(formRef.current);
  }

  function startNewPhrase() {
    setEntropy(newEntropy(12));
    setPositions(pickPositions(12));
    setAnswers(["", "", ""]);
    setLocalError("");
    setStep("show");
  }

  function chooseLength(value) {
    const n = value === "24" ? 24 : 12;
    if (n === words.length) return;
    setEntropy(newEntropy(n));
    setPositions(pickPositions(n));
    setAnswers(["", "", ""]);
    setCopied(false);
  }

  async function copyWords() {
    try {
      await navigator.clipboard.writeText(words.join(" "));
      setCopied(true);
    } catch {
      setLocalError("Could not copy. Select the phrase and copy it by hand.");
    }
  }

  function downloadWords() {
    const lines = words.map((w, i) => `${i + 1}. ${w}`).join("\n");
    const text = `Luna recovery phrase\n\n${lines}\n\nKeep these ${words.length} words somewhere safe. Anyone with them can open your cloud backups.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "luna-recovery-phrase.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function answer(isExposed) {
    setExposed(isExposed);
    setLocalError("");
    if (lost) setStep("password");
    else startNewPhrase();
  }

  async function submitPassword(event) {
    event.preventDefault();
    if (proving || busy || !password) return;
    const typed = password;
    setPassword("");
    setLocalError("");
    setProving(true);
    try {
      const ok = await onProve({ password: typed });
      if (ok === false) {
        fail(error ? "" : "That is not your Luna password. Try again.");
        return;
      }
      startNewPhrase();
    } catch (err) {
      fail(err?.message || "Could not check your password. Try again.");
    } finally {
      setProving(false);
    }
  }

  async function verifyOldPhrase(phrase) {
    const ok = await onProve({ phrase });
    return ok !== false;
  }

  function save(event) {
    event.preventDefault();
    if (busy) return;
    const wrong = positions.findIndex((pos, i) => answers[i].trim().toLowerCase() !== words[pos]);
    if (wrong !== -1) {
      fail(`Word ${positions[wrong] + 1} doesn't match. Check your phrase and try again.`);
      return;
    }
    setLocalError("");
    onSave({ exposed, newPhrase: words.join(" ") });
  }

  if (saved) {
    return (
      <ConfirmModal
        open={open}
        onClose={onClose}
        onConfirm={() => onRetire()}
        variant="warning"
        title="Delete older private versions?"
        confirmLabel="Delete older versions"
        loading={retiring}
        error={retireError || null}
      >
        <div className="space-y-2">
          <p className="text-primary text-sm">
            This deletes earlier versions of your private items, and files you deleted that exist only in the cloud. They can't be brought back.
          </p>
          <p className="text-primary text-sm">
            If you cancel, Luna keeps them, and your old phrase may still open them.
          </p>
        </div>
      </ConfirmModal>
    );
  }

  if (step === "warn") {
    return (
      <ConfirmModal
        open={open}
        onClose={onClose}
        onConfirm={() => setStep("question")}
        variant="warning"
        title="Get a new phrase?"
        confirmLabel="Continue"
      >
        <div className="space-y-2">
          <p className="text-primary text-sm">Private items backed up with your old phrase can't be opened anymore.</p>
          <p className="text-primary text-sm">Your shared cloud backups stay open to you with the new phrase.</p>
        </div>
      </ConfirmModal>
    );
  }

  if (step === "check") {
    return (
      <RecoveryPhraseCheck
        open={open}
        mode="step"
        title="Enter your current phrase"
        submitLabel="Continue"
        error={error}
        verify={verifyOldPhrase}
        onVerified={() => setStep("question")}
        onClose={onClose}
      />
    );
  }

  if (step === "question") {
    return (
      <ModalCard open={open} title="Could someone else have your phrase?" onClose={onClose} size="md">
        <div className="space-y-5">
          <Answer
            label={lost ? "No, it's just lost" : "No, it's only mine"}
            lines={["Nothing uploads again.", ...(privateLine ? [privateLine.safe] : [])]}
            onPick={() => answer(false)}
          />
          <Answer
            label="Someone may have it"
            lines={[MAY_HAVE_IT, CONNECT_NOTE, ...(privateLine ? [privateLine.exposed] : [])]}
            onPick={() => answer(true)}
          />
        </div>
      </ModalCard>
    );
  }

  if (step === "password") {
    return (
      <ModalCard open={open} title="Confirm it's you" onClose={onClose} size="md">
        <form ref={formRef} onSubmit={submitPassword} className="space-y-4">
          <label className="block space-y-1">
            <span className="text-primary text-sm">Your Luna password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              className="w-full rounded-pill surface-primary border border-transparent px-4 py-2 text-sm outline-none focus:border-accent motion-safe:transition-colors"
            />
          </label>
          {shownError && <PageNotice variant="error">{shownError}</PageNotice>}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="sm" loading={proving} disabled={proving || busy || !password}>
              Continue
            </Button>
          </div>
        </form>
      </ModalCard>
    );
  }

  if (step === "show") {
    return (
      <ModalCard open={open} title="Your new recovery phrase" onClose={onClose} size="md">
        <div className="space-y-4">
          <p className="text-primary text-sm">
            Write these {words.length} words down in order and keep them somewhere safe. Anyone with them can open your cloud backups.
          </p>
          <SegmentedControl
            aria-label="Number of words"
            surface="secondary"
            value={String(words.length)}
            options={LENGTH_OPTIONS}
            onChange={chooseLength}
          />
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {words.map((word, i) => (
              <li key={i} className="flex items-center gap-2 rounded-pill surface-primary px-3 py-2 text-sm">
                <span className="w-5 text-right text-xs font-mono">{i + 1}.</span>
                <InlinePill>{word}</InlinePill>
              </li>
            ))}
          </ol>
          {localError && <PageNotice variant="error">{localError}</PageNotice>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={copyWords}>{copied ? "Copied" : "Copy"}</Button>
            <Button variant="outline" size="sm" onClick={downloadWords}>Download</Button>
            <Button variant="primary" size="sm" onClick={() => { setLocalError(""); setStep("confirm"); }}>
              I wrote them down
            </Button>
          </div>
        </div>
      </ModalCard>
    );
  }

  return (
    <ModalCard open={open} title="Confirm your new phrase" onClose={onClose} size="md">
      <form ref={formRef} onSubmit={save} className="space-y-4">
        <p className="text-primary text-sm">Type {positionsSentence(positions)} of your new phrase to confirm you wrote it down.</p>
        {positions.map((pos, i) => (
          <label key={pos} className="block space-y-1">
            <span className="text-primary text-sm">Word {pos + 1}</span>
            <input
              type="text"
              value={answers[i]}
              onChange={(e) => setAnswers((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="w-full rounded-pill surface-primary border border-transparent px-4 py-2 text-sm outline-none focus:border-accent motion-safe:transition-colors"
            />
          </label>
        ))}
        {shownError && <PageNotice variant="error">{shownError}</PageNotice>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { setLocalError(""); setStep("show"); }}>
            Back to the phrase
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={busy}>
            Save recovery phrase
          </Button>
        </div>
      </form>
    </ModalCard>
  );
}

PhraseReplaceFlow.propTypes = {
  kind: PropTypes.oneOf(["change", "lost"]).isRequired,
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  onProve: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
  busy: PropTypes.bool,
  error: PropTypes.string,
  saved: PropTypes.bool,
  onRetire: PropTypes.func,
  retiring: PropTypes.bool,
  retireError: PropTypes.string,
};
