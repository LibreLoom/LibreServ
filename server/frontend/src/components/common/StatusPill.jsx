/* color-scan: ignore-file dynamic color-mix with CSS variables */
import { CheckCircle, XCircle, AlertCircle, Circle } from "lucide-react";
import PropTypes from "prop-types";

const statusConfig = {
  running: {
    icon: CheckCircle,
    label: "Running",
    colorVar: "--color-success",
    bgVar: "--bg-success",
  },
  stopped: {
    icon: XCircle,
    label: "Stopped",
    colorVar: "--color-warning",
    bgVar: "--bg-warning",
  },
  error: {
    icon: AlertCircle,
    label: "Error",
    colorVar: "--color-error",
    bgVar: "--bg-error",
  },
  unknown: {
    icon: Circle,
    label: "Unknown",
    colorVar: "--color-secondary",
    bgVar: "--bg-info",
  },
};

export default function StatusPill({ status, className = "" }) {
  const config = statusConfig[status] || statusConfig.unknown;
  const Icon = config.icon;

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill ${className}`}
        style={{
          backgroundColor: `var(${config.bgVar})`,
          color: `var(--color-secondary)`,
        }}
    >
      <span
        className="flex items-center justify-center rounded-full p-0.5"
        style={{
          backgroundColor: `var(${config.colorVar})`,
        }}
      >
        <Icon size={12} strokeWidth={2.5} />
      </span>
      <span className="text-xs font-mono font-medium">{config.label}</span>
    </div>
  );
}

StatusPill.propTypes = {
  status: PropTypes.oneOf(["running", "stopped", "error", "unknown"]),
  className: PropTypes.string,
};