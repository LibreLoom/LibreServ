import { CheckCircle, XCircle, AlertCircle, ChevronDown } from "lucide-react";
import CardButton from "./CardButton";
import MiniStatCard from "./MiniStatCard";

// Status configuration mapping for different service states
const statusConfig = {
  online: {
    icon: CheckCircle,
    color: "text-accent",
    label: "Online",
  },
  offline: {
    icon: XCircle,
    color: "text-accent",
    label: "Offline",
  },
  warning: {
    icon: AlertCircle,
    color: "text-accent",
    label: "Warning",
  },
};

/**
 * Renders a bar of vertical lines to indicate usage percentage
 * @param {number} percentage - Usage percentage (0-100)
 * @param {number} totalBars - Total number of bars to display
 */
function UsageBar({ percentage, totalBars = 10 }) {
  const filledBars = Math.round((percentage / 100) * totalBars);

  return (
    <span className="text-primary tracking-tight" aria-hidden="true">
      {Array.from({ length: totalBars }, (_, i) => (
        <span key={i} className={i < filledBars ? "opacity-100" : "opacity-25"}>
          |
        </span>
      ))}
    </span>
  );
}

// Resource key to display label mapping
const resourceLabels = {
  cpu: "CPU",
  ram: "RAM",
  disk: "Disk",
  net: "Network",
  energy: "Energy",
};

/**
 * Converts resources object to array format for display
 * @param {Object} resources - Object with resource keys and decimal values (0-1)
 * @returns {Array} Array of { label, value } objects with percentage values
 */
function normalizeResources(resources) {
  if (!resources) return [];
  if (Array.isArray(resources)) return resources;

  return Object.entries(resources).map(([key, value]) => ({
    label: resourceLabels[key] || key.toUpperCase(),
    value: Math.round(value * 100),
  }));
}

export default function DetailedStatCard({
  icon: Icon,
  name,
  status,
  time,
  warningMessage,
  resources = {},
}) {
  const config = statusConfig[status] || statusConfig.offline;
  const StatusIcon = config.icon;

  // Convert resources object to array format
  const resourceList = normalizeResources(resources);

  // Determine status text based on current state
  let statusText;
  if (status === "online" && time) {
    statusText = `Uptime: ${time}`;
  } else if (status === "offline" && time) {
    statusText = `Downtime: ${time}`;
  } else if (status === "warning" && warningMessage) {
    statusText = warningMessage;
  }

  return (
    <div className="pop-in flex-1 m-1.25 bg-secondary text-primary rounded-3xl p-6 motion-safe:transition hover:scale-[1.01] self-start">
      {/* Header with service icon and name */}
      <div className="flex items-center gap-4 mb-4">
        <div className="h-16 w-16 rounded-pill bg-primary text-secondary flex items-center justify-center">
          <Icon size={28} aria-hidden="true" />
        </div>
        <div className="text-left">
          <div className="text-xl font-semibold">{name}</div>
          {statusText && (
            <div className="flex items-center gap-2 text-sm mt-1">
              <StatusIcon size={16} className={config.color} aria-hidden="true" />
              <span className={config.color}>{statusText}</span>
            </div>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="h-1 bg-primary rounded-pill mx-1 my-4" />

      {/* Resource usage with vertical bar indicators */}
      <div className="space-y-3">
        <div className={`text-primary text-sm font-medium ${config.color}`}>
          Resource Usage
        </div>
        {resourceList.map((resource) => (
          <div
            key={resource.label}
            className="flex items-center gap-3 font-mono text-sm"
          >
            <UsageBar percentage={resource.value} />
            <span className="text-primary w-12 text-right" aria-label={`${resource.value}%`}>
              {resource.value}%
            </span>
            <span className="text-accent">{resource.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
