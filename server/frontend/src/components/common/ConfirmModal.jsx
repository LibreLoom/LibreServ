import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard";
import Callout from "./Callout";

const CONFIRM_CLASS = {
  default: "bg-accent text-primary hover:ring-2 hover:ring-accent",
  warning: "bg-warning text-secondary hover:ring-2 hover:ring-primary",
  danger: "bg-error text-secondary hover:ring-2 hover:ring-primary",
  "danger-undoable": "bg-error text-secondary hover:ring-2 hover:ring-primary",
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
  const [isClosing, setIsClosing] = useState(false);
  const shouldRender = open || isClosing;
  const iconColor = variant === "danger" || variant === "danger-undoable" ? "text-error" : variant === "warning" ? "text-warning" : "text-accent";
  const confirmClass = CONFIRM_CLASS[variant] || CONFIRM_CLASS.default;
  const bannerTone = BANNER_TONE[variant];

  const handleClose = useCallback(() => {
    if (loading || isClosing) return;
    setIsClosing(true);
    setTimeout(() => {
      onClose?.();
      setIsClosing(false);
    }, 200);
  }, [loading, isClosing, onClose]);

  const handleConfirm = useCallback(() => {
    if (loading) return;
    onConfirm?.();
  }, [loading, onConfirm]);

  if (!shouldRender) return null;

  return (
    <ModalCard
      title={title}
      onClose={handleClose}
      size="sm"
      className={isClosing ? "animate-out fade-out" : "animate-in fade-in"}
      initialFocusRef={initialFocusRef}
    >
      <div className="flex items-start gap-3">
        {Icon && (
          <div className="flex-shrink-0 mt-0.5" aria-hidden="true">
            <Icon size={24} className={iconColor} />
          </div>
        )}
        <div className="flex-1">
          {message && (
            <p className="font-mono text-sm text-primary/70 mb-2">{message}</p>
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
        <button
          onClick={handleClose}
          disabled={loading}
          className={cn("flex-1 px-4 py-2 rounded-pill border-2 border-accent/30 bg-secondary text-primary hover:bg-accent/20 transition-all font-mono text-sm disabled:opacity-50")}
        >
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={loading || disabledConfirm}
          className={cn("flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill transition-all font-mono text-sm disabled:opacity-50", confirmClass)}
        >
          {loading ? (
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          ) : ConfirmIcon ? (
            <ConfirmIcon size={16} aria-hidden="true" />
          ) : null}
          {loading ? "Processing..." : confirmLabel}
        </button>
      </div>
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