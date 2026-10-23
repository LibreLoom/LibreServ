import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import { phraseToEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { shakeElement } from "@libreloom/ui/utils/shake.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

const LENGTH_OPTIONS = [
  { value: "12", label: "12 words" },
  { value: "24", label: "24 words" },
];

const WORDS = new Set(wordlist);
const MAX_SUGGESTIONS = 5;
const WRONG_PHRASE = "That is not the recovery phrase set up on this Luna. Check each word and try again.";

const blankWords = () => Array(24).fill("");

/** Words typed or pasted as one run of text, lowercased and split on any whitespace. */
function splitWords(text) {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Asks for the recovery phrase one word per box and hands it to `verify`.
 * Props only: the caller decides how the phrase is proven (`verify` resolves true or false).
 * `mode="check"` shows the result here; `mode="step"` hands the phrase to `onVerified`
 * straight away, as the first step of a change or a dashboard reminder.
 * The phrase lives only in this component's state and is wiped when it closes.
 */
export default function RecoveryPhraseCheck({
  open = true,
  onClose,
  onVerified = null,
  verify,
  mode = "check",
  error: externalError = "",
  title = "Check my phrase",
  submitLabel = "Check",
}) {
  const [count, setCount] = useState(12);
  const [words, setWords] = useState(blankWords);
  const [focused, setFocused] = useState(-1);
  const [error, setError] = useState("");
  const [matched, setMatched] = useState(false);
  const [checking, setChecking] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const inputs = useRef([]);
  const suggestionsRef = useRef(null);
  const formRef = useRef(null);

  // Wipe the phrase whenever the dialog closes or goes away.
  useEffect(() => {
    if (open) return undefined;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear secret state on close
    setWords(blankWords());
    setError("");
    setMatched(false);
    setCount(12);
    return undefined;
  }, [open]);
  useEffect(() => () => { inputs.current = []; }, []);

  const shown = words.slice(0, count);
  const invalid = shown.map((w, i) => w !== "" && !WORDS.has(w) && !(i === focused && wordlist.some((x) => x.startsWith(w))));
  const complete = shown.every((w) => WORDS.has(w));

  // Not memoized: `shown` is a new array on every render, so a memo here could never hold.
  const focusedWord = focused >= 0 ? shown[focused] : "";
  const suggestions = !focusedWord || WORDS.has(focusedWord)
    ? []
    : wordlist.filter((x) => x.startsWith(focusedWord)).slice(0, MAX_SUGGESTIONS);

  function focusBox(index) {
    inputs.current[index]?.focus();
  }

  /**
   * Put `list` into boxes starting at `start`. A whole phrase (exactly 12 or 24 words) always fills
   * from box 1 and sets the box count to its length. Any other length fills from `start` and never
   * goes past the boxes shown.
   */
  function spread(start, list) {
    const whole = list.length === 12 || list.length === 24;
    const from = whole ? 0 : start;
    const nextCount = whole ? list.length : count;
    setCount(nextCount);
    setWords((prev) => {
      const next = whole ? blankWords() : [...prev];
      list.forEach((w, i) => {
        if (from + i < nextCount) next[from + i] = w;
      });
      return next;
    });
    setError("");
    setMatched(false);
    focusBox(Math.min(nextCount - 1, from + list.length));
  }

  function onBoxChange(index, raw) {
    const list = splitWords(raw);
    const endsWithSpace = /\s$/.test(raw);
    if (list.length > 1 || (list.length === 1 && endsWithSpace)) {
      spread(index, list);
      return;
    }
    setWords((prev) => prev.map((w, i) => (i === index ? (list[0] || "") : w)));
    setError("");
    setMatched(false);
  }

  function onBoxPaste(index, event) {
    const list = splitWords(event.clipboardData?.getData("text") || "");
    if (list.length < 2) return;
    event.preventDefault();
    spread(index, list);
  }

  function pick(word) {
    const box = focused;
    spread(box, [word]);
    setActiveSuggestion(-1);
  }

  /** ArrowUp/ArrowDown walk the suggestions and Enter takes the highlighted one; Enter otherwise submits. */
  function onBoxKeyDown(index, event) {
    if (index !== focused || suggestions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveSuggestion((a) => (a < 0 ? (step === 1 ? 0 : suggestions.length - 1) : (a + step + suggestions.length) % suggestions.length));
      haptic("selection");
    } else if (event.key === "Enter" && activeSuggestion >= 0 && suggestions[activeSuggestion]) {
      event.preventDefault();
      haptic("selection");
      pick(suggestions[activeSuggestion]);
    }
  }

  function chooseCount(value) {
    setCount(value === "24" ? 24 : 12);
    setError("");
  }

  function fail(message) {
    setError(message);
    shakeElement(formRef.current);
  }

  async function submit(event) {
    event.preventDefault();
    if (checking) return;
    setError("");
    setMatched(false);
    const phrase = shown.join(" ");
    try {
      phraseToEntropy(phrase);
    } catch (err) {
      fail(err.message);
      return;
    }
    setChecking(true);
    try {
      const ok = await verify(phrase);
      if (!ok) {
        fail(WRONG_PHRASE);
        return;
      }
      if (mode === "check") setMatched(true);
      onVerified?.(phrase);
      if (mode === "check") setWords(blankWords());
    } catch (err) {
      fail(err?.message || "Could not check your phrase. Try again.");
    } finally {
      setChecking(false);
    }
  }

  const firstInvalid = invalid.findIndex(Boolean);
  const message = error || externalError;

  return (
    <ModalCard open={open} title={title} onClose={onClose} size="md">
      <form ref={formRef} onSubmit={submit} className="space-y-4">
        <p className="text-primary text-sm">Type your recovery phrase, one word in each box. You can also paste all of it into any box.</p>
        <SegmentedControl
          aria-label="Number of words"
          surface="secondary"
          value={String(count)}
          options={LENGTH_OPTIONS}
          onChange={chooseCount}
        />
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {shown.map((word, i) => (
            <li key={i} className="flex items-center gap-2">
              <label className="flex w-full items-center gap-2">
                <span className="w-6 text-right text-xs font-mono">{i + 1}.</span>
                <input
                  ref={(el) => { inputs.current[i] = el; }}
                  type="text"
                  value={word}
                  aria-label={`Word ${i + 1}`}
                  aria-invalid={invalid[i] ? "true" : undefined}
                  onChange={(e) => onBoxChange(i, e.target.value)}
                  onPaste={(e) => onBoxPaste(i, e)}
                  onFocus={() => { setFocused(i); setActiveSuggestion(-1); }}
                  onKeyDown={(e) => onBoxKeyDown(i, e)}
                  onBlur={(e) => {
                    // Moving onto a suggestion keeps the suggestions for this box.
                    if (suggestionsRef.current?.contains(e.relatedTarget)) return;
                    setFocused((f) => (f === i ? -1 : f));
                  }}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className={`w-full min-w-0 rounded-pill surface-primary border px-3 py-2 text-sm outline-none focus:border-accent motion-safe:transition-colors ${invalid[i] ? "border-error" : "border-transparent"}`}
                />
              </label>
            </li>
          ))}
        </ol>
        {suggestions.length > 0 && (
          <div
            ref={suggestionsRef}
            className="flex flex-wrap gap-2"
            role="group"
            aria-label={`Suggestions for word ${focused + 1}`}
            onBlur={(e) => {
              if (e.relatedTarget && (suggestionsRef.current?.contains(e.relatedTarget) || inputs.current.includes(e.relatedTarget))) return;
              setFocused(-1);
            }}
          >
            {suggestions.map((s, n) => (
              <Button
                key={s}
                variant={n === activeSuggestion ? "primary" : "outline"}
                surface="secondary"
                size="sm"
                aria-pressed={n === activeSuggestion}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
              >
                {s}
              </Button>
            ))}
          </div>
        )}
        {firstInvalid !== -1 && (
          <PageNotice variant="warning">{`Word ${firstInvalid + 1} is not on the recovery phrase list. Check the spelling.`}</PageNotice>
        )}
        {message && <PageNotice variant="error">{message}</PageNotice>}
        {matched && <PageNotice variant="info" surface="primary">Your phrase matches. You have the right recovery phrase.</PageNotice>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="sm" loading={checking} disabled={checking || !complete}>
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
};
