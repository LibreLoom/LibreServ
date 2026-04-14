import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard";

const VARIANTS = {
  default: {
    iconColor: "text-accent",
    bannerClass: "bg-primary/10 border-primary/20 text-primary",
    confirmClass: "bg-accent text-primary hover:ring-2 hover:ring-accent",
  },
  warning: {
    iconColor: "text-warning",
    bannerClass: "bg-warning/10 border-warning/30 text-warning",
    confirmClass: "bg-warning text-primary hover:ring-2 hover:ring-primary",
  },
  danger: {
    iconColor: "text-error",
    bannerClass: "bg-error/10 border-error/30 text-error",
    confirmClass: "bg-error text-primary hover:ring-2 hover:ring-primary",
  },
};

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
}) {
  const [isClosing, setIsClosing] = useState(false);
  const shouldRender = open || isClosing;
  const styles = VARIANTS[variant] || VARIANTS.default;

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
    >
      <div className="flex items-start gap-3">
        {Icon && (
          <div className="flex-shrink-0 mt-0.5" aria-hidden="true">
            <Icon size={24} className={styles.iconColor} />
          </div>
        )}
        <div className="flex-1">
          {message && (
            <p className="font-mono text-sm text-primary/70 mb-2">{message}</p>
          )}
          {children}
        </div>
      </div>

      {variant !== "default" && (
        <div className={`mt-4 border rounded-card p-3 ${styles.bannerClass}`}>
          <p className="font-mono text-xs">
            {variant === "danger"
              ? "This action cannot be undone."
              : "Please review before proceeding."}
          </p>
        </div>
      )}

      <div className="flex gap-3 mt-6">
        <button
          onClick={handleClose}
          disabled={loading}
          className="flex-1 px-4 py-2 rounded-pill border-2 border-accent/30 bg-secondary text-primary hover:bg-accent/20 transition-all font-mono text-sm disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={loading}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill transition-all font-mono text-sm disabled:opacity-50 ${styles.confirmClass}`}
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
  variant: PropTypes.oneOf(["default", "warning", "danger"]),
  confirmLabel: PropTypes.string,
  confirmIcon: PropTypes.elementType,
  loading: PropTypes.bool,
};