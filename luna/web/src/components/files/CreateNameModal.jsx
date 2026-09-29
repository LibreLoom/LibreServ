import { useEffect, useRef } from "react";
import PropTypes from "prop-types";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";

/**
 * Name prompt for creating or renaming a folder or file. Opens with the
 * name focused and selected up to its extension, so typing replaces it.
 *
 * @param {{
 *   open: boolean,
 *   title: string,
 *   label: string,
 *   placeholder?: string,
 *   hint?: string,
 *   value: string,
 *   keepExtension?: boolean,
 *   onChange: (next: string) => void,
 *   confirmLabel: string,
 *   busy?: boolean,
 *   error?: string | null,
 *   onSubmit: () => void | Promise<void>,
 *   onClose: () => void,
 * }} props
 */
export default function CreateNameModal({
  open,
  title,
  label,
  placeholder,
  hint,
  value,
  keepExtension = true,
  onChange,
  confirmLabel,
  busy = false,
  error = null,
  onSubmit,
  onClose,
}) {
  const inputRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  const selectedRef = useRef(false);
  useEffect(() => {
    if (open) selectedRef.current = false;
  }, [open]);

  return (
    <ModalCard open={open} title={title} onClose={onClose} initialFocusRef={inputRef}>
      {({ close }) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            Promise.resolve(onSubmit())
              .then(() => close())
              .catch(() => {});
          }}
        >
          <ShakeTarget shake={error}>
            <label className="block text-primary text-sm">
              <span className="block translate-x-5">{label}</span>
              <input
                className="mt-2 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm outline-none focus:border-accent"
                value={value}
                maxLength={255}
                placeholder={placeholder}
                ref={inputRef}
                onFocus={(event) => {
                  if (selectedRef.current) return;
                  selectedRef.current = true;
                  selectName(event.currentTarget, keepExtension);
                }}
                onChange={(event) => onChange(event.target.value)}
              />
            </label>
          </ShakeTarget>
          {hint ? (
            <p className="mt-2 text-sm text-primary">{hint}</p>
          ) : null}
          {error ? (
            <PageNotice variant="error" className="mt-2">{error}</PageNotice>
          ) : null}
          <div className="mt-4 flex gap-3">
            <Button variant="primary" type="submit" loading={busy}>
              {confirmLabel}
            </Button>
            <Button variant="outline" type="button" onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </ModalCard>
  );
}

/**
 * Select the name for replacing: everything before the last dot when the
 * extension should stay (not for dotfiles like `.env`), otherwise all of it.
 *
 * @param {HTMLInputElement} input
 * @param {boolean} keepExtension
 */
function selectName(input, keepExtension) {
  const dot = keepExtension ? input.value.lastIndexOf(".") : -1;
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
}

CreateNameModal.propTypes = {
  open: PropTypes.bool.isRequired,
  title: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  placeholder: PropTypes.string,
  hint: PropTypes.string,
  value: PropTypes.string.isRequired,
  keepExtension: PropTypes.bool,
  onChange: PropTypes.func.isRequired,
  confirmLabel: PropTypes.string.isRequired,
  busy: PropTypes.bool,
  error: PropTypes.string,
  onSubmit: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
