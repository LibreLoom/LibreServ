import { useCallback, useRef } from "react";
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
 * @property {string} [overlayClassName] Passed to ModalCard (e.g. stack above lightbox).
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
  overlayClassName,
}) {
  // Freeze copy while exiting so parents can clear the subject (userToDelete, etc.)
  // without blanking the modal mid-animation.
  const snapRef = useRef({
    title,
    message,
    children,
    Icon,
    variant,
    confirmLabel,
    ConfirmIcon,
  });
  if (open) {
    snapRef.current = {
      title,
      message,
      children,
      Icon,
      variant,
      confirmLabel,
      ConfirmIcon,
    };
  }
  const snap = snapRef.current;

  const iconColor =
    snap.variant === "danger" || snap.variant === "danger-undoable"
      ? "text-error"
      : snap.variant === "warning"
        ? "text-warning"
        : "text-accent";
  const confirmVariant = CONFIRM_VARIANT[snap.variant] || CONFIRM_VARIANT.default;
  const bannerTone = BANNER_TONE[snap.variant];
  const SnapIcon = snap.Icon;
  const SnapConfirmIcon = snap.ConfirmIcon;

  const handleConfirm = useCallback(() => {
    if (loading) return;
    onConfirm?.();
  }, [loading, onConfirm]);

  return (
    <ModalCard
      open={open}
      title={snap.title}
      onClose={onClose}
      size="sm"
      initialFocusRef={initialFocusRef}
      overlayClassName={overlayClassName}
    >
      {({ close }) => (
        <>
          <div className="flex items-start gap-3">
            {SnapIcon && (
              <div className="flex-shrink-0 mt-0.5" aria-hidden="true">
                <SnapIcon size={24} className={iconColor} />
              </div>
            )}
            <div className="flex-1">
              {snap.message && (
                <p className="font-mono text-sm text-primary mb-2">{snap.message}</p>
              )}
              {snap.children}
            </div>
          </div>

          {bannerTone && (
            <div className="mt-4">
              <Callout tone={bannerTone} rounded="card">
                {snap.variant === "danger"
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
              className={snap.variant === "warning" ? "flex-1 bg-warning text-secondary" : "flex-1"}
            >
              {!loading && SnapConfirmIcon ? (
                <SnapConfirmIcon size={16} aria-hidden="true" />
              ) : null}
              {loading ? "Processing..." : snap.confirmLabel}
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
  overlayClassName: PropTypes.string,
};
