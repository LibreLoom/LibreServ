import PropTypes from "prop-types";
import { AlertCircle, CheckCircle, AlertTriangle, Info } from "lucide-react";

const VARIANTS = {
  error: { icon: AlertCircle, bg: "bg-error/10", border: "border-error/20", text: "text-error" },
  success: { icon: CheckCircle, bg: "bg-success/10", border: "border-success/20", text: "text-success" },
  warning: { icon: AlertTriangle, bg: "bg-warning/10", border: "border-warning/20", text: "text-warning" },
  info: { icon: Info, bg: "bg-info/10", border: "border-info/20", text: "text-info" },
};

export default function Alert({ variant = "info", message, className = "" }) {
  const config = VARIANTS[variant] || VARIANTS.info;
  const Icon = config.icon;

  return (
    <div className={`p-3 ${config.bg} ${config.border} border rounded-pill flex items-start gap-2 ${className}`}>
      <Icon size={16} className={`${config.text} mt-0.5 flex-shrink-0`} aria-hidden="true" />
      <div className={`text-sm ${config.text}`}>{message}</div>
    </div>
  );
}

Alert.propTypes = {
  variant: PropTypes.oneOf(["error", "success", "warning", "info"]),
  message: PropTypes.string.isRequired,
  className: PropTypes.string,
};
