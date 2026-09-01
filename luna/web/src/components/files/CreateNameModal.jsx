import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import ShakeTarget from "../components/ui/ShakeTarget.jsx";
import PageNotice from "../common/PageNotice.jsx";

/**
 * Name prompt for creating a folder or file in the current folder.
 *
 * @param {{
 *   open: boolean,
 *   title: string,
 *   label: string,
 *   hint?: string,
 *   value: string,
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
  hint,
  value,
  onChange,
  confirmLabel,
  busy = false,
  error = null,
  onSubmit,
  onClose,
}) {
  return (
    <ModalCard open={open} title={title} onClose={onClose}>
      {({ close }) => (
        <ShakeTarget
          as="form"
          shake={error}
          onSubmit={(event) => {
            event.preventDefault();
            Promise.resolve(onSubmit())
              .then(() => close())
              .catch(() => {});
          }}
        >
          <label className="block text-primary text-sm">
            {label}
            <input
              className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              value={value}
              maxLength={255}
              autoFocus
              onChange={(event) => onChange(event.target.value)}
            />
          </label>
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
        </ShakeTarget>
      )}
    </ModalCard>
  );
}

CreateNameModal.propTypes = {
  open: PropTypes.bool.isRequired,
  title: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  hint: PropTypes.string,
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  confirmLabel: PropTypes.string.isRequired,
  busy: PropTypes.bool,
  error: PropTypes.string,
  onSubmit: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
