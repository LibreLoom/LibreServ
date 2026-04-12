import { CheckCircle2, XCircle, Info, X } from "lucide-react";
import PropTypes from "prop-types";
import { useToast } from "../../context/ToastContext";

const TYPE_CONFIG = {
  success: {
    icon: CheckCircle2,
    bgColorClass: "bg-success",
  },
  error: {
    icon: XCircle,
    bgColorClass: "bg-error",
  },
  info: {
    icon: Info,
    bgColorClass: "bg-info",
  },
};

function Toast({ toast, onDismiss }) {
  const config = TYPE_CONFIG[toast.type] || TYPE_CONFIG.info;
  const Icon = config.icon;

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`
        flex items-start gap-3
        min-w-[280px] max-w-[380px]
        bg-secondary text-primary
        rounded-large-element
        border border-primary/10
        shadow-lg
        p-3
        ${toast.exiting ? "animate-toast-exit" : "animate-toast-enter"}
      `}
      onClick={() => !toast.exiting && onDismiss(toast.id)}
    >
      <div
        className={`
          flex-shrink-0 flex items-center justify-center
          w-7 h-7 rounded-full
          ${config.bgColorClass}
        `}
      >
        <Icon size={16} className="text-primary" strokeWidth={2.5} />
      </div>

      <div className="flex-1 min-w-0 py-0.5">
        <p className="font-mono text-sm font-medium text-primary truncate">
          {toast.message}
        </p>
        {toast.description && (
          <p className="text-xs text-primary/60 mt-1 leading-relaxed">
            {toast.description}
          </p>
        )}
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(toast.id);
        }}
        className="flex-shrink-0 p-1 -mr-1 -mt-1 text-primary/30 hover:text-primary/60 transition-colors rounded"
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );
}

Toast.propTypes = {
  toast: PropTypes.shape({
    id: PropTypes.number.isRequired,
    type: PropTypes.oneOf(["success", "error", "info"]).isRequired,
    message: PropTypes.string.isRequired,
    description: PropTypes.string,
    exiting: PropTypes.bool,
  }).isRequired,
  onDismiss: PropTypes.func.isRequired,
};

export default function Toaster() {
  const { toasts, dismissToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-6 z-[9999] flex flex-col gap-2 pointer-events-auto"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}
