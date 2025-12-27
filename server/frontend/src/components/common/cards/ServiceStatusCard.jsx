import { useState } from "react";
import { CheckCircle, XCircle, AlertCircle, ChevronDown } from "lucide-react";
import CardButton from "./CardButton";
import MiniStatCard from "./MiniStatCard";

// Status configuration mapping for different service states
const statusConfig = {
  online: {
    icon: CheckCircle,
    color: "text-accent",
    bg: "bg-secondary",
    label: "Online",
  },
  offline: {
    icon: XCircle,
    color: "text-accent",
    bg: "bg-secondary",
    label: "Offline",
  },
  warning: {
    icon: AlertCircle,
    color: "text-accent",
    bg: "bg-secondary",
    label: "Warning",
  },
};

/**
 * ServiceStatusCard - Displays a service's status, uptime/downtime, and resource usage
 * Cards grow to fill available space (flex-1) with 5px margin for consistent spacing
 */
export default function ServiceStatusCard({
  icon: Icon,
  name,
  status,
  time,
  warningMessage,
  resourceUsage,
  breakdownItems = [],
}) {
  const [isOpen, setIsOpen] = useState(false);
  const config = statusConfig[status] || statusConfig.offline;
  const StatusIcon = config.icon;

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
    // flex-1: grow to fill space, m-[5px]: 5px margin on all sides
    <div className="flex-1 m-[5px] bg-secondary text-primary rounded-3xl p-5 motion-safe:transition hover:scale-[1.02] self-start">
      {/* Header with service icon and name */}
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-pill bg-primary text-secondary flex items-center justify-center">
          <Icon size={22} />
        </div>
        <div className="text-left">
          <div className="font-semibold">{name}</div>
        </div>
      </div>

      {/* Divider */}
      <div className="h-1 bg-primary rounded-pill mx-1 my-4" />

      {/* Status and resource usage info */}
      <div className="text-left">
        <div className={`text-sm ${config.color}`}>Status</div>
        {statusText && (
          <div className="flex items-center gap-1 text-sm ml-2.5">
            <StatusIcon size={14} className={config.color} />
            <span className={config.color}>{statusText}</span>
          </div>
        )}
        <div className={`text-sm ${config.color}`}>Resource Usage</div>
        {resourceUsage != null && (
          <div className="flex items-center gap-1 text-sm ml-2.5">
            {/* Circle indicator with fill opacity based on usage percentage */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              className={config.color}
            >
              <circle
                cx="7"
                cy="7"
                r="6"
                fill="currentColor"
                fillOpacity={resourceUsage / 100}
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
            <span className={config.color}>{resourceUsage}%</span>
          </div>
        )}
      </div>

      {/* Expandable breakdown section */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-sm text-accent hover:text-primary mt-3 cursor-pointer"
      >
        <ChevronDown
          size={16}
          className={`motion-safe:transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
        />
        <span>{isOpen ? "Hide breakdown" : "Show breakdown"}</span>
      </button>

      {/* Collapsible breakdown content */}
      <div
        className={`overflow-y-hidden overflow-x-visible motion-safe:transition-all duration-300 ease-out ${
          isOpen ? "max-h-96" : "max-h-0"
        }`}
      >
        <div className="grid grid-cols-2 gap-2 pt-4">
          {breakdownItems.map((item) => (
            <MiniStatCard
              key={item.label}
              icon={item.icon}
              label={item.label}
              value={item.value}
            />
          ))}
        </div>
      </div>

      <CardButton action={"/apps/" + name} actionLabel="Manage" />
    </div>
  );
}
