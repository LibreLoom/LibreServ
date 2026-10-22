import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";

/**
 * Text box for the recovery phrase (12 or 24 words). A layered field: it sits on a card (secondary), so it
 * takes the primary surface and reads as an inset.
 * @param {{
 *   value: string,
 *   onChange: (value: string) => void,
 *   label?: string,
 *   placeholder?: string,
 *   fieldRef?: import("react").Ref<HTMLTextAreaElement>,
 *   rows?: number,
 * }} props
 */
export function PhraseField({
  value,
  onChange,
  label = "Recovery phrase",
  placeholder,
  fieldRef,
  rows = 3,
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-primary text-sm">{label}</span>
      <textarea
        ref={fieldRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
        className="w-full resize-none rounded-large-element surface-primary border border-transparent p-3 text-sm outline-none focus:border-accent motion-safe:transition-colors"
      />
    </label>
  );
}

PhraseField.propTypes = {
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  label: PropTypes.string,
  placeholder: PropTypes.string,
  fieldRef: PropTypes.oneOfType([PropTypes.func, PropTypes.object]),
  rows: PropTypes.number,
};

/**
 * The form both "bring back" cards share: a phrase box, the warning about where to type it,
 * an inline error, and one submit button.
 * @param {{
 *   words: string,
 *   onWords: (value: string) => void,
 *   onSubmit: (event: import("react").FormEvent) => void,
 *   error?: string,
 *   pending?: boolean,
 *   submitLabel: string,
 *   fieldRef?: import("react").Ref<HTMLTextAreaElement>,
 *   progress?: { type?: string, message?: string, processed?: number, total?: number, snapshots?: number, already_indexed?: number, skipped?: number } | null,
 *   onCancel?: () => void,
 * }} props
 */
export default function RestoreForm({ words, onWords, onSubmit, error = "", pending = false, submitLabel, fieldRef, progress = null, onCancel }) {
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <PhraseField
        value={words}
        onChange={onWords}
        fieldRef={fieldRef}
        placeholder="Your recovery words, with spaces between them"
      />
      <p className="text-primary text-sm">
        Only type your recovery phrase on this Luna or on <InlinePill>connect.luna.libreloom.org</InlinePill>.
      </p>
      {error && <PageNotice variant="error">{error}</PageNotice>}
      <Button type="submit" variant="primary" size="sm" loading={pending} disabled={pending || !words.trim()}>
        {submitLabel}
      </Button>
      {pending && progress?.type !== "finishing" && (
        <Button type="button" variant="outline" surface="secondary" size="sm" onClick={onCancel}>
          Stop restore
        </Button>
      )}
      {pending && (
        <div className="space-y-2" role="status" aria-live="polite">
          <p className="text-primary text-sm">
            {progress?.type === "finishing"
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
              {progress.snapshots} restored · {progress.already_indexed} already on Luna · {progress.skipped} could not be checked
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
