import { useState } from "react";
import { CheckCircle, XCircle, AlertCircle, ChevronDown } from "lucide-react";
import CardButton from "./CardButton";
import MiniStatCard from "./MiniStatCard";

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
  const IconComponent = Icon;

  // Determine what status text to show
  let statusText;
  if (status === "online" && time) {
    statusText = `Uptime: ${time}`;
  } else if (status === "offline" && time) {
    statusText = `Downtime: ${time}`;
  } else if (status === "warning" && warningMessage) {
    statusText = warningMessage;
  }

  return (
    <div className="max-w-90 bg-secondary text-primary rounded-3xl p-5 motion-safe:transition hover:scale-[1.02] self-start">
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-pill bg-primary text-secondary flex items-center justify-center">
          <IconComponent size={22} />
        </div>
        <div className="text-left">
          <div className="font-semibold">{name}</div>
        </div>
      </div>
      <div className="h-1 bg-primary rounded-pill mx-1 my-4" />
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
            <span className={config.color}>{resourceUsage + "%"}</span>
          </div>
        )}
      </div>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-sm text-accent hover:text-primary mt-3 cursor-pointer"
      >
        <ChevronDown
          size={16}
          className={`motion-safe:transition-transform duration-200 ${isOpen ? "rotate-180" : "rotate-0"}`}
        />
        <span>{isOpen ? "Hide breakdown" : "Show breakdown"}</span>
      </button>
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
