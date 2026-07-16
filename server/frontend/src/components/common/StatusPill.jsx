import PropTypes from "prop-types";
import Pill from "./Pill";
import { statusConfig } from "../../data/statusConfig";

// Map a runtime status string to the same token-based variant the rest of the
// status-color system uses (bg-X/20 border-X/30 text-X). Replaces the separate
// --bg-* rgba system that escaped scan:colors and that no audit could see.
const STATUS_VARIANT = {
  running: "success",
  stopped: "warning",
  error: "error",
  unknown: "info",
};

export default function StatusPill({ status, className = "", compact = false }) {
  const config = statusConfig[status] || statusConfig.unknown;
  const Icon = config.icon;
  const variant = STATUS_VARIANT[status] || "info";
  return (
    <Pill variant={variant} className={className}>
      <Icon size={12} strokeWidth={2.5} aria-hidden="true" />
      {!compact && <span className="font-mono font-medium">{config.label}</span>}
    </Pill>
  );
}

StatusPill.propTypes = {
  status: PropTypes.oneOf(["running", "stopped", "error", "unknown"]),
  className: PropTypes.string,
  compact: PropTypes.bool,
};