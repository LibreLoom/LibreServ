import { useEffect, useRef } from "react";
import { Circle, Loader2, CheckCircle2, XCircle } from "lucide-react";
import PropTypes from "prop-types";

const STATUS_CONFIG = {
  idle: {
    visible: false,
  },
  unsaved: {
    icon: Circle,
    iconClass: "text-primary/40",
    text: "Unsaved changes",
    textClass: "text-primary/60",
  },
  saving: {
    icon: Loader2,
    iconClass: "text-accent animate-spin",
    text: "Saving...",
    textClass: "text-accent",
  },
  saved: {
    icon: CheckCircle2,
    iconClass: "text-success",
    text: "Saved",
    textClass: "text-success",
  },
  error: {
    icon: XCircle,
    iconClass: "text-error",
    text: "Failed to save",
    textClass: "text-error",
    showRetry: true,
  },
};

export default function SaveStatusIndicator({
  status = "idle",
  onRetry,
  savedDuration = 3000,
  onSavedComplete,
}) {
  const config = STATUS_CONFIG[status];
  const savedTimeoutRef = useRef(null);

  useEffect(() => {
    if (savedTimeoutRef.current) {
      clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = null;
    }

    if (status === "saved" && savedDuration > 0) {
      savedTimeoutRef.current = setTimeout(() => {
        onSavedComplete?.();
      }, savedDuration);
    }

    return () => {
      if (savedTimeoutRef.current) {
        clearTimeout(savedTimeoutRef.current);
      }
    };
  }, [status, savedDuration, onSavedComplete]);

  if (!config || config.visible === false) {
    return null;
  }

  const Icon = config.icon;

  return (
    <div
      className={`
        inline-flex items-center gap-1.5
        font-mono text-xs
        animate-in fade-in slide-in-from-top-1
        duration-200
      `}
    >
      <Icon size={14} className={config.iconClass} />
      <span className={config.textClass}>{config.text}</span>
      {config.showRetry && onRetry && (
        <button
          onClick={onRetry}
          className="ml-1 underline underline-offset-2 hover:no-underline text-accent hover:text-primary transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  );
}

SaveStatusIndicator.propTypes = {
  status: PropTypes.oneOf(["idle", "unsaved", "saving", "saved", "error"]),
  onRetry: PropTypes.func,
  savedDuration: PropTypes.number,
  onSavedComplete: PropTypes.func,
};
