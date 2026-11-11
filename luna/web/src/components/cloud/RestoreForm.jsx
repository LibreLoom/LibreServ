import { useState } from "react";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import { phraseToEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import PhraseWordsInput from "./PhraseWordsInput.jsx";

/** The boxes for one phrase, kept as a string so the caller can send it as-is. */
function wordsToBoxes(words, count) {
  const parsed = words ? words.split(" ") : [];
  return Array.from({ length: count }, (_, i) => parsed[i] ?? "");
}

/** A whole phrase, or the sentence saying why the boxes do not make one. */
function phraseProblem(boxes) {
  if (boxes.some((word) => !word)) return "";
  try {
    phraseToEntropy(boxes.join(" "));
    return "";
  } catch {
    return "These words don't form a recovery phrase. A word may be wrong or out of order.";
  }
}

/**
 * The form both "bring back" cards share: the numbered word boxes, the warning
 * about where to type it, an inline error, and one submit button.
 * @param {{
 *   words: string,
 *   onWords: (value: string) => void,
 *   onSubmit: (event: import("react").FormEvent) => void,
 *   error?: string,
 *   pending?: boolean,
 *   submitLabel: string,
 *   fieldRef?: import("react").Ref<HTMLDivElement>,
 *   progress?: { type?: string, message?: string, processed?: number, total?: number, snapshots?: number, already_indexed?: number, skipped?: number } | null,
 *   onCancel?: () => void,
 * }} props
 */
export default function RestoreForm({ words, onWords, onSubmit, error = "", pending = false, submitLabel, fieldRef, progress = null, onCancel }) {
  const [count, setCount] = useState(() => (wordsToBoxes(words, 24).filter(Boolean).length > 12 ? 24 : 12));
  const boxes = wordsToBoxes(words, count);
  const complete = boxes.every(Boolean);
  const problem = phraseProblem(boxes);

  function changeBoxes(next) {
    onWords(next.slice(0, count).join(" "));
  }

  function changeCount(next) {
    const nextBoxes = wordsToBoxes(words, next);
    setCount(next);
    onWords(nextBoxes.join(" "));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div ref={fieldRef} className="space-y-2">
        <p className="text-primary text-sm">Recovery phrase</p>
        <PhraseWordsInput
          count={count}
          words={boxes}
          onChange={changeBoxes}
          onCountChange={changeCount}
          lengthKnown={false}
        />
      </div>
      <p className="text-primary text-sm">
        Only type your recovery phrase on this Luna or on <InlinePill>connect.luna.libreloom.org</InlinePill>.
      </p>
      {problem && <p className="text-primary text-sm" role="alert">{problem}</p>}
      {error && <InlineError>{error}</InlineError>}
      <Button
        type="submit"
        variant="primary"
        size="sm"
        loading={pending}
        disabled={pending || !complete || Boolean(problem)}
      >
        {submitLabel}
      </Button>
      {pending && onCancel && progress?.type !== "finishing" && (
        <Button type="button" variant="outline" surface="secondary" size="sm" onClick={onCancel}>
          Stop restore
        </Button>
      )}
      {pending && (
        <div className="space-y-2" role="status" aria-live="polite">
          <p className="text-primary text-sm">
            {progress?.type === "finishing" || progress?.message
              ? progress.message
              : progress?.total
              ? `Restoring backup ${progress.processed} of ${progress.total}`
              : "Connecting to your cloud backups…"}
          </p>
          <progress
            className="w-full accent-accent"
            max={Math.max(progress?.total || 1, 1)}
            value={progress?.processed || 0}
            aria-label="Cloud backup restore progress"
          />
          {progress && (
            <p className="text-secondary text-sm">
              {progress.snapshots} restored · {progress.already_indexed} already on Luna · {progress.skipped > 0
                ? `Luna couldn't open ${progress.skipped} backup ${progress.skipped === 1 ? "version" : "versions"}`
                : "No backup versions skipped"}
            </p>
          )}
        </div>
      )}
    </form>
  );
}

RestoreForm.propTypes = {
  words: PropTypes.string.isRequired,
  onWords: PropTypes.func.isRequired,
  onSubmit: PropTypes.func.isRequired,
  error: PropTypes.string,
  pending: PropTypes.bool,
  submitLabel: PropTypes.string.isRequired,
  fieldRef: PropTypes.oneOfType([PropTypes.func, PropTypes.object]),
  progress: PropTypes.object,
  onCancel: PropTypes.func,
};
