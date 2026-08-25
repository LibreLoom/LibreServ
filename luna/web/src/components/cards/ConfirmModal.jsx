import { useCallback } from "react";
import PropTypes from "prop-types";
import ModalCard from "./ModalCard";
import Callout from "../common/Callout";
import Button from "../ui/Button";

// Maps the modal's semantic variant to the canonical Button variant.
// "warning" keeps its yellow fill via a className override since Button has
// no warning variant of its own.
const CONFIRM_VARIANT = {
  default: "accent",
  warning: "accent",
  danger: "danger",
  "danger-undoable": "danger",
};

const BANNER_TONE = {
  warning: "warning",
  danger: "error",
  "danger-undoable": "error",
};

/**
 * @typedef {object} ConfirmModalProps
 * @property {boolean} open
 * @property {() => void} [onClose]
 * @property {() => void} [onConfirm]
 * @property {import('react').ElementType} [icon]
 * @property {string} title
 * @property {import('react').ReactNode} [children]
 * @property {string} [message]
 * @property {"default"|"warning"|"danger"|"danger-undoable"} [variant]
 * @property {string} [confirmLabel]
 * @property {import('react').ElementType} [confirmIcon]
 * @property {boolean} [loading]
 * @property {boolean} [disabledConfirm]
 * @property {import('react').RefObject} [initialFocusRef]
 */

/** @param {ConfirmModalProps} props */
export default function ConfirmModal({
  open,
  onClose,
  onConfirm,
  icon: Icon,
  title,
  children,
  message,
  variant = "default",
  confirmLabel = "Confirm",
  confirmIcon: ConfirmIcon,
  loading = false,
  disabledConfirm = false,
  initialFocusRef,
}) {
  const iconColor = variant === "danger" || variant === "danger-undoable" ? "text-error" : variant === "warning" ? "text-warning" : "text-accent";
  const confirmVariant = CONFIRM_VARIANT[variant] || CONFIRM_VARIANT.default;
  const bannerTone = BANNER_TONE[variant];

  const handleConfirm = useCallback(() => {
    if (loading) return;
    onConfirm?.();
  }, [loading, onConfirm]);

  if (!open) return null;

  return (
    <ModalCard
      title={title}
      onClose={onClose}
      size="sm"
      initialFocusRef={initialFocusRef}
    >
      {({ close }) => (
        <>
          <div className="flex items-start gap-3">
            {Icon && (
              <div className="flex-shrink-0 mt-0.5" aria-hidden="true">
                <Icon size={24} className={iconColor} />
              </div>
            )}
            <div className="flex-1">
              {message && (
                <p className="font-mono text-sm text-primary mb-2">{message}</p>
              )}
              {children}
            </div>
          </div>

          {bannerTone && (
            <div className="mt-4">
              <Callout tone={bannerTone} rounded="card">
                {variant === "danger"
                  ? "This action cannot be undone."
                  : "Please review before proceeding."}
              </Callout>
            </div>
          )}

          <div className="flex gap-3 mt-6">
            <Button
              variant="outline"
              surface="secondary"
              onClick={close}
              disabled={loading}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              variant={confirmVariant}
              onClick={handleConfirm}
              loading={loading}
              disabled={disabledConfirm}
              className={variant === "warning" ? "flex-1 bg-warning text-secondary" : "flex-1"}
            >
              {!loading && ConfirmIcon ? (
                <ConfirmIcon size={16} aria-hidden="true" />
              ) : null}
              {loading ? "Processing..." : confirmLabel}
            </Button>
          </div>
        </>
      )}
    </ModalCard>
  );
}

ConfirmModal.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func,
  onConfirm: PropTypes.func,
  icon: PropTypes.elementType,
  title: PropTypes.string.isRequired,
  children: PropTypes.node,
  message: PropTypes.string,
  variant: PropTypes.oneOf(["default", "warning", "danger", "danger-undoable"]),
  confirmLabel: PropTypes.string,
  confirmIcon: PropTypes.elementType,
  loading: PropTypes.bool,
  disabledConfirm: PropTypes.bool,
  initialFocusRef: PropTypes.object,
};