import { useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import PropTypes from "prop-types";
import { AlertCircle, Check } from "lucide-react";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { blankWords, boxState, notOnListLine, splitPhraseText, WORD_SET } from "../../lib/cloudPhrase";

const LENGTH_OPTIONS = [
  { value: "12", label: "12 words" },
  { value: "24", label: "24 words" },
];

const MAX_SUGGESTIONS = 5;

/** List words that start with `value`. None when `value` is already a whole list word. */
function matchesFor(value) {
  return value && !WORD_SET.has(value) ? wordlist.filter((w) => w.startsWith(value)) : [];
}

/**
 * One numbered word box with its suggestion chips on their own row below it. Render it inside an
 * `<ol>` laid out as a grid: it returns the box's `<li>` and, while typing, a full-width `<li>` of chips.
 * Keys (all on the input, none global): Space or Enter takes the highlighted chip, or moves on from a
 * finished word; Backspace in an empty box goes back; ArrowLeft/ArrowRight at the ends of the text move
 * between boxes; ArrowUp/ArrowDown walk the chips.
 * @param {{
 *   position: number,
 *   value: string,
 *   onChange: (word: string) => void,
 *   onPasteWords?: (words: string[]) => void,
 *   onAdvance?: (via: "space" | "enter" | "chip") => void,
 *   onPrev?: () => void,
 *   onNext?: () => void,
 *   enterSubmits?: boolean,
 *   placeholder?: string,
 *   enterKeyHint?: "next" | "done",
 *   inputRef?: (el: HTMLInputElement | null) => void,
 *   describedById?: string,
 *   onFocusChange?: (focused: boolean) => void,
 *   forceInvalid?: boolean,
 * }} props
 */
export function WordBox({
  position,
  value,
  onChange,
  onPasteWords,
  onAdvance,
  onPrev,
  onNext,
  enterSubmits = false,
  placeholder,
  enterKeyHint = "next",
  inputRef,
  describedById,
  onFocusChange,
  forceInvalid = false,
}) {
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const inputEl = useRef(null);
  const chipsRef = useRef(null);

  const matches = focused ? matchesFor(value) : [];
  const chips = matches.slice(0, MAX_SUGGESTIONS);
  // One possible word is highlighted already; otherwise the arrows choose.
  const highlighted = active >= 0 && active < chips.length ? active : matches.length === 1 ? 0 : -1;
  const state = forceInvalid ? "invalid" : boxState(value, focused);

  function setFocus(next) {
    setFocused(next);
    onFocusChange?.(next);
  }

  function take(word) {
    setActive(-1);
    onChange(word);
    onAdvance?.("chip");
  }

  function handleChange(event) {
    const raw = event.target.value;
    setActive(-1);
    const list = splitPhraseText(raw);
    if (list.length > 1) {
      onPasteWords?.(list);
      return;
    }
    const word = list[0] || "";
    // Some phones send Space as a plain character, not a key press: treat it the same way.
    if (word && /\s$/.test(raw)) {
      const only = matchesFor(word);
      if (WORD_SET.has(word)) {
        onChange(word);
        onAdvance?.("space");
      } else if (only.length === 1) {
        haptic("selection");
        onChange(only[0]);
        onAdvance?.("chip");
      } else {
        onChange(word);
      }
      return;
    }
    onChange(word);
  }

  function handlePaste(event) {
    const list = splitPhraseText(event.clipboardData?.getData("text") || "");
    if (list.length < 2) return;
    event.preventDefault();
    onPasteWords?.(list);
  }

  function handleKeyDown(event) {
    const key = event.key;
    if ((key === "ArrowDown" || key === "ArrowUp") && chips.length > 0) {
      event.preventDefault();
      const step = key === "ArrowDown" ? 1 : -1;
      setActive((a) => {
        const from = highlighted >= 0 ? highlighted : a;
        return from < 0 ? (step === 1 ? 0 : chips.length - 1) : (from + step + chips.length) % chips.length;
      });
      haptic("selection");
      return;
    }
    if (key === " " || key === "Enter") {
      if (highlighted >= 0) {
        event.preventDefault();
        haptic("selection");
        take(chips[highlighted]);
        return;
      }
      if (WORD_SET.has(value)) {
        if (key === " ") {
          event.preventDefault();
          onAdvance?.("space");
        } else if (!enterSubmits) {
          event.preventDefault();
          onAdvance?.("enter");
        }
        return;
      }
      // A word has no spaces inside it. Enter falls through and submits the form.
      if (key === " ") event.preventDefault();
      return;
    }
    if (key === "Backspace" && value === "" && onPrev) {
      event.preventDefault();
      onPrev();
      return;
    }
    const el = event.currentTarget;
    if (key === "ArrowLeft" && el.selectionStart === 0 && el.selectionEnd === 0 && onPrev) {
      event.preventDefault();
      onPrev();
    } else if (key === "ArrowRight" && el.selectionStart === value.length && el.selectionEnd === value.length && onNext) {
      event.preventDefault();
      onNext();
    }
  }

  return (
    <>
      <li>
        <label className="flex w-full items-center gap-2">
          <span className="w-6 shrink-0 text-right text-xs font-mono">{position}.</span>
          <span className="relative block w-full min-w-0">
            <input
              ref={(el) => {
                inputEl.current = el;
                inputRef?.(el);
              }}
              type="text"
              value={value}
              aria-label={`Word ${position}`}
              aria-invalid={state === "invalid" ? "true" : undefined}
              aria-describedby={state === "invalid" ? describedById : undefined}
              onChange={handleChange}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                setFocus(true);
                setActive(-1);
              }}
              onBlur={(e) => {
                // Moving onto a chip keeps the chips for this box.
                if (chipsRef.current?.contains(e.relatedTarget)) return;
                setFocus(false);
              }}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint={enterKeyHint}
              placeholder={placeholder}
              className={cn(
                "w-full min-w-0 rounded-pill surface-primary border px-3 py-2 pr-9 text-sm outline-none motion-safe:transition-colors",
                state === "invalid" ? "border-error" : "border-transparent focus:border-accent",
              )}
            />
            {state === "valid" && (
              <Check
                size={ICON_SIZE.sm}
                aria-hidden="true"
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-success motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-50 motion-safe:duration-150"
              />
            )}
            {state === "invalid" && (
              <AlertCircle
                size={ICON_SIZE.sm}
                aria-hidden="true"
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-error"
              />
            )}
          </span>
        </label>
      </li>
      {/* Right after its box, so Tab from the box lands on the chips. */}
      {chips.length > 0 && (
        <li className="col-span-full">
          <div
            ref={chipsRef}
            className="flex flex-wrap gap-2"
            role="group"
            aria-label={`Suggestions for word ${position}`}
            onBlur={(e) => {
              if (e.relatedTarget && (chipsRef.current?.contains(e.relatedTarget) || e.relatedTarget === inputEl.current)) return;
              setFocus(false);
            }}
          >
            {chips.map((chip, n) => (
              <Button
                key={chip}
                variant={n === highlighted ? "primary" : "outline"}
                surface="secondary"
                size="sm"
                haptic="selection"
                aria-pressed={n === highlighted}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => take(chip)}
              >
                {chip}
              </Button>
            ))}
          </div>
        </li>
      )}
    </>
  );
}

WordBox.propTypes = {
  position: PropTypes.number.isRequired,
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  onPasteWords: PropTypes.func,
  onAdvance: PropTypes.func,
  onPrev: PropTypes.func,
  onNext: PropTypes.func,
  enterSubmits: PropTypes.bool,
  placeholder: PropTypes.string,
  enterKeyHint: PropTypes.oneOf(["next", "done"]),
  inputRef: PropTypes.func,
  describedById: PropTypes.string,
  onFocusChange: PropTypes.func,
  forceInvalid: PropTypes.bool,
};

/**
 * The numbered word boxes for typing or pasting a recovery phrase. Controlled: `words` holds up to
 * 24 entries and the first `count` show. When the length is not known (`lengthKnown` false) a 12/24
 * switch shows, and pasting 12 or 24 words sets the count through `onCountChange`.
 * Its `ref` offers `focus()` (box 1), `focusBox(index)` and `firstEmpty()`. `strict` marks every unfinished word as not on the list, even in the box being typed in (used after a failed submit).
 * @param {{
 *   count: number,
 *   words: string[],
 *   onChange: (words: string[]) => void,
 *   onCountChange?: (count: number) => void,
 *   lengthKnown?: boolean,
 *   describedById?: string,
 *   strict?: boolean,
 *   ref?: import("react").Ref<{ focus: () => void, focusBox: (index: number) => void, firstEmpty: () => number }>,
 * }} props
 */
export default function PhraseWordsInput({
  count,
  words,
  onChange,
  onCountChange,
  lengthKnown = false,
  describedById,
  strict = false,
  ref,
}) {
  const ownId = useId();
  const lineId = describedById || `${ownId}-problems`;
  const boxes = useRef(/** @type {Array<HTMLInputElement | null>} */ ([]));
  const pendingFocus = useRef(-1);
  const [focused, setFocused] = useState(-1);
  const [pasteProblem, setPasteProblem] = useState("");

  const shown = words.slice(0, count);
  const allComplete = shown.every((w) => WORD_SET.has(w));
  const invalid = shown
    .map((w, i) => (boxState(w, !strict && i === focused) === "invalid" ? i + 1 : 0))
    .filter(Boolean);
  const problem = pasteProblem || (invalid.length > 0 ? notOnListLine(invalid) : "");

  // Focus a box once it exists (a pasted 24-word phrase adds boxes in the same update).
  useEffect(() => {
    if (pendingFocus.current < 0) return;
    boxes.current[pendingFocus.current]?.focus();
    pendingFocus.current = -1;
  });

  useImperativeHandle(ref, () => ({
    focus: () => boxes.current[0]?.focus(),
    focusBox: (index) => boxes.current[index]?.focus(),
    firstEmpty: () => shown.findIndex((w) => !w),
  }));

  function setWord(index, word) {
    setPasteProblem("");
    onChange(words.map((w, i) => (i === index ? word : w)));
  }

  function goTo(index) {
    if (index >= 0 && index < count) boxes.current[index]?.focus();
  }

  /**
   * Put pasted words into the boxes. A whole phrase (12 or 24 words) fills from box 1; any other
   * number fills from the box where it was pasted and never goes past the last box.
   */
  function spread(start, list) {
    const whole = list.length === 12 || list.length === 24;
    if (whole && lengthKnown && list.length !== count) {
      setPasteProblem(`That's ${list.length} words. Your recovery phrase has ${count}.`);
      return;
    }
    setPasteProblem("");
    const nextCount = whole ? list.length : count;
    if (whole && list.length !== count) onCountChange?.(list.length);
    const from = whole ? 0 : start;
    const next = whole ? blankWords() : [...words];
    list.forEach((w, i) => {
      if (from + i < nextCount) next[from + i] = w;
    });
    onChange(next);
    pendingFocus.current = Math.min(nextCount - 1, from + list.length);
  }

  return (
    <div className="space-y-3">
      {!lengthKnown && (
        <SegmentedControl
          aria-label="Number of words"
          surface="secondary"
          value={String(count)}
          options={LENGTH_OPTIONS}
          onChange={(value) => {
            setPasteProblem("");
            onCountChange?.(value === "24" ? 24 : 12);
          }}
        />
      )}
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shown.map((word, i) => (
          <WordBox
            key={i}
            position={i + 1}
            value={word}
            onChange={(w) => setWord(i, w)}
            onPasteWords={(list) => spread(i, list)}
            onAdvance={() => goTo(i + 1)}
            onPrev={i > 0 ? () => {
              goTo(i - 1);
              const el = boxes.current[i - 1];
              if (el) el.setSelectionRange(el.value.length, el.value.length);
            } : undefined}
            onNext={i < count - 1 ? () => goTo(i + 1) : undefined}
            enterSubmits={i === count - 1 || allComplete}
            enterKeyHint={i === count - 1 ? "done" : "next"}
            placeholder={i === 0 ? "Type or paste" : undefined}
            describedById={lineId}
            forceInvalid={strict && word !== "" && !WORD_SET.has(word)}
            inputRef={(el) => {
              boxes.current[i] = el;
            }}
            onFocusChange={(isFocused) => setFocused((f) => (isFocused ? i : f === i ? -1 : f))}
          />
        ))}
      </ol>
      {problem && (
        <p id={lineId} className="flex items-start gap-2 text-sm text-primary">
          <AlertCircle size={ICON_SIZE.sm} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
          <span>{problem}</span>
        </p>
      )}
    </div>
  );
}

PhraseWordsInput.propTypes = {
  count: PropTypes.number.isRequired,
  words: PropTypes.arrayOf(PropTypes.string).isRequired,
  onChange: PropTypes.func.isRequired,
  onCountChange: PropTypes.func,
  lengthKnown: PropTypes.bool,
  describedById: PropTypes.string,
  strict: PropTypes.bool,
  ref: PropTypes.oneOfType([PropTypes.func, PropTypes.object]),
};
