import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import CardButton from "@libreloom/ui/components/ui/CardButton.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { entropyToPhrase } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { shakeElement } from "@libreloom/ui/utils/shake.js";
import RecoveryPhraseCheck from "./RecoveryPhraseCheck.jsx";
import PhraseWriteDown from "./PhraseWriteDown.jsx";

const NO_HEADINGS = { show: "", confirm: "" };

const MAY_HAVE_IT =
  "Your old phrase stops working right away. Luna then moves your cloud backups to the new phrase in the background, which can take days. Until it finishes, someone who already used your old phrase could still open files that haven't changed.";
const CONNECT_NOTE =
  "Your old phrase alone does not open backups on Connect. That also takes your Connect sign-in or a share link.";

/** Private-history lines for the lost flow (plan 4.3): without the old phrase, Luna can't keep them. */
const LOST_PRIVATE_LINES = {
  safe: "Luna keeps your older private items for 30 days in case you find your phrase, then removes them.",
  exposed: "Luna removes your older private items now.",
};

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
 * change: check the old phrase, ask the question, show and confirm the new phrase (PhraseWriteDown), save.
 * lost: say what is lost, ask the question, ask for the Luna password, new phrase, save.
 * `onProve(proof)` gets `{ phrase }` (change) or `{ password }` (lost) and may resolve false
 * to refuse it; `error` is the caller's inline message (wrong password, locked out, save failed).
 * `words` is the length of the phrase being replaced (12, 24 or 0 when unknown); `onLost` is the check's
 * "Lost your phrase?" button. The new phrase and the password live only in this component's state.
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
  passwordRetry = 0,
  words: oldLength = 0,
  onLost = null,
}) {
  const lost = kind === "lost";
  const [step, setStep] = useState(lost ? "warn" : "check");
  const [exposed, setExposed] = useState(false);
  const [password, setPassword] = useState("");
  const [proving, setProving] = useState(false);
  const [localError, setLocalError] = useState("");
  const [writeStep, setWriteStep] = useState("show");
  const formRef = useRef(null);
  const savingRef = useRef(false);

  // Wipe everything secret when the dialog closes.
  useEffect(() => {
    if (open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- clear secret state on close */
    setStep(lost ? "warn" : "check");
    setPassword("");
    setWriteStep("show");
    setExposed(false);
    setLocalError("");
    savingRef.current = false;
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, lost]);

  // The caller refused the password: drop the new phrase and ask for the password again.
  const seenRetry = useRef(passwordRetry);
  useEffect(() => {
    if (passwordRetry === seenRetry.current) return;
    seenRetry.current = passwordRetry;
    setPassword("");
    setLocalError("");
    setStep("password");
  }, [passwordRetry]);

  // A save is in flight until the caller finishes (busy ends) or answers (an error, or a refused password).
  useEffect(() => {
    if (!busy) savingRef.current = false;
  }, [busy, error, passwordRetry]);

  const privateLine = lost ? LOST_PRIVATE_LINES : null;
  const shownError = localError || error;

  function fail(message) {
    setLocalError(message);
    shakeElement(formRef.current);
  }

  function startNewPhrase() {
    setLocalError("");
    setWriteStep("show");
    setStep("write");
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

  /** The new phrase is written down and confirmed: hand it to the caller to save. */
  function save(entropy) {
    if (busy || savingRef.current) return;
    setLocalError("");
    savingRef.current = true;
    onSave({ exposed, newPhrase: entropyToPhrase(entropy) });
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
        words={oldLength}
        onLost={onLost}
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

  return (
    <ModalCard
      open={open}
      title={writeStep === "confirm" ? "Confirm your new phrase" : "Your new recovery phrase"}
      onClose={onClose}
      size="md"
    >
      <PhraseWriteDown
        surface="secondary"
        saveLabel="Save recovery phrase"
        titles={NO_HEADINGS}
        intro={null}
        busy={busy}
        error={shownError}
        onStepChange={setWriteStep}
        onSave={save}
      />
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
  passwordRetry: PropTypes.number,
  words: PropTypes.number,
  onLost: PropTypes.func,
};
