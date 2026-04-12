import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import PropTypes from "prop-types";
import Card from "../cards/Card";

const VARIANTS = {
  default: {
    bannerClass: "bg-primary/10 border-primary/20 text-primary",
    confirmClass: "bg-accent text-primary hover:ring-2 hover:ring-accent",
  },
  warning: {
    bannerClass: "bg-warning/10 border-warning/30 text-warning",
    confirmClass: "bg-warning text-primary hover:ring-2 hover:ring-primary",
  },
  danger: {
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
  className = "",
}) {
  const [isClosing, setIsClosing] = useState(false);
  const shouldRender = open || isClosing;
  const styles = VARIANTS[variant] || VARIANTS.default;

  const handleClose = useCallback(() => {
    if (isClosing || loading) return;
    setIsClosing(true);
    setTimeout(() => {
      onClose?.();
      setIsClosing(false);
    }, 200);
  }, [isClosing, loading, onClose]);

  const handleConfirm = useCallback(() => {
    if (loading) return;
    onConfirm?.();
  }, [loading, onConfirm]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
      }
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, handleClose]);

  if (!shouldRender) return null;

  return (
    <div
      className={`fixed inset-0 bg-primary/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 ${
        isClosing ? "animate-out fade-out" : "animate-in fade-in"
      }`}
      onClick={handleClose}
    >
      <div
        className={`max-w-md w-full ${className}`}
        onClick={(event) => event.stopPropagation()}
      >
        <Card
          className={`${isClosing ? "animate-out fade-out zoom-out-95" : "animate-in fade-in zoom-in-95"}`}
          padding={false}
        >
          <div className="flex items-start gap-3 p-6 pb-4">
            {Icon && (
              <div className="flex-shrink-0 mt-0.5">
                {variant === "danger" ? (
                  <Icon size={24} className="text-error" />
                ) : variant === "warning" ? (
                  <Icon size={24} className="text-warning" />
                ) : (
                  <Icon size={24} className="text-accent" />
                )}
              </div>
            )}
            <div className="flex-1">
              <h2 className="font-mono text-lg text-primary">{title}</h2>
              {message && (
                <p className="font-mono text-sm text-primary/70 mt-1">{message}</p>
              )}
              {children}
            </div>
          </div>

          {variant !== "default" && (
            <div className={`mx-6 mb-4 border rounded-card p-3 ${styles.bannerClass}`}>
              <p className="font-mono text-xs">
                {variant === "danger"
                  ? "This action cannot be undone."
                  : "Please review before proceeding."}
              </p>
            </div>
          )}

          <div className="flex gap-3 p-6 pt-2">
            <button
              onClick={handleClose}
              disabled={loading}
              className="flex-1 px-4 py-2 rounded-pill bg-primary/10 text-primary hover:bg-primary/20 transition-all font-mono text-sm disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill transition-all font-mono text-sm disabled:opacity-50 ${styles.confirmClass}`}
            >
              {loading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : ConfirmIcon ? (
                <ConfirmIcon size={16} />
              ) : null}
              {loading ? "Processing..." : confirmLabel}
            </button>
          </div>
        </Card>
      </div>
    </div>
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
  className: PropTypes.string,
};
