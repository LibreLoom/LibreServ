import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import { phraseToEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { shakeElement } from "@libreloom/ui/utils/shake.js";
import { blankWords, WORD_SET } from "../../lib/cloudPhrase";
import PhraseWordsInput from "./PhraseWordsInput.jsx";

const REFUSED = "That isn't the recovery phrase for your account. Check each word against what you wrote down.";

/**
 * Asks for the recovery phrase, every word in order, and hands it to `verify`.
 * Props only: the caller decides how the phrase is proven (`verify` resolves true or false).
 * Success is always `onVerified(phrase)`; the caller closes the dialog (and toasts, when it is a check).
 * `words` is how many words the phrase has (12 or 24, or 0 when Luna doesn't know yet, which shows a switch).
 * The phrase lives only in this component's state and is wiped when it closes or succeeds.
 */
export default function RecoveryPhraseCheck({
  open = true,
  onClose,
  onVerified = null,
  verify,
  // eslint-disable-next-line no-unused-vars -- kept so older callers can still pass it
  mode = "check",
  error: externalError = "",
  title = "Check my phrase",
  submitLabel = "Check",
  words: knownCount = 0,
  onLost = null,
}) {
  const lengthKnown = knownCount === 12 || knownCount === 24;
  const [pickedCount, setPickedCount] = useState(12);
  const count = lengthKnown ? knownCount : pickedCount;
  const [typed, setTyped] = useState(blankWords);
  const [error, setError] = useState("");
  const [refused, setRefused] = useState(false);
  const [strict, setStrict] = useState(false);
  const [checking, setChecking] = useState(false);
  const inputRef = useRef(null);
  const formRef = useRef(null);

  // Wipe the phrase whenever the dialog closes or goes away.
  useEffect(() => {
    if (open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- clear secret state on close */
    setTyped(blankWords());
    setError("");
    setRefused(false);
    setStrict(false);
    setPickedCount(12);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  const shown = typed.slice(0, count);
  const filled = shown.filter((w) => WORD_SET.has(w)).length;
  const message = error || externalError;

  function change(next) {
    setTyped(next);
    setError("");
    setStrict(false);
  }

  function fail(text) {
    setError(text);
    shakeElement(formRef.current);
  }

  async function submit(event) {
    event.preventDefault();
    if (checking) return;
    setError("");
    const empty = shown.findIndex((w) => !w);
    if (empty !== -1) {
      fail(`Fill in word ${empty + 1}.`);
      inputRef.current?.focusBox(empty);
      return;
    }
    const off = shown.map((w, i) => (WORD_SET.has(w) ? 0 : i + 1)).filter(Boolean);
    if (off.length > 0) {
      setStrict(true);
      shakeElement(formRef.current);
      inputRef.current?.focusBox(off[0] - 1);
      return;
    }
    const phrase = shown.join(" ");
    try {
      phraseToEntropy(phrase);
    } catch {
      fail(`These ${count} words don't form a recovery phrase. A word may be wrong or out of order.`);
      return;
    }
    setChecking(true);
    try {
      const ok = await verify(phrase);
      if (!ok) {
        setRefused(true);
        fail(REFUSED);
        return;
      }
      setTyped(blankWords());
      setRefused(false);
      onVerified?.(phrase);
    } catch (err) {
      fail(err?.message || "Could not check your phrase. Try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <ModalCard open={open} title={title} onClose={onClose} size="md" initialFocusRef={inputRef}>
      <form ref={formRef} onSubmit={submit} noValidate className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-primary text-sm">
            {lengthKnown
              ? `Type your ${count} words in order, from where you wrote them down.`
              : "Type your recovery phrase in order, from where you wrote it down."}
          </p>
          <span className="shrink-0 text-xs font-mono">{`${filled} of ${count}`}</span>
        </div>
        <PhraseWordsInput
          ref={inputRef}
          count={count}
          words={typed}
          onChange={change}
          onCountChange={(n) => {
            setPickedCount(n);
            setError("");
          }}
          lengthKnown={lengthKnown}
          strict={strict}
        />
        {message && <PageNotice variant="error">{message}</PageNotice>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {refused && onLost && (
            <Button type="button" variant="ghost" surface="secondary" size="sm" onClick={onLost}>
              Lost your phrase?
            </Button>
          )}
          <Button type="submit" variant="primary" size="sm" loading={checking} disabled={checking}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </ModalCard>
  );
}

RecoveryPhraseCheck.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  onVerified: PropTypes.func,
  verify: PropTypes.func.isRequired,
  mode: PropTypes.oneOf(["check", "step"]),
  error: PropTypes.string,
  title: PropTypes.string,
  submitLabel: PropTypes.string,
  words: PropTypes.number,
  onLost: PropTypes.func,
};
