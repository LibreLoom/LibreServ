import { useState, memo } from "react";
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

function ServiceStatusCardInner({
  icon: Icon,
  name,
  status,
  time,
  warningMessage,
  resourceUsage,
  breakdownItems = [],
}) {
  const [isOpen, setIsOpen] = useState(false);
  const breakdownId = `service-breakdown-${String(name)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")}`;
  const config = statusConfig[status] || statusConfig.offline;
  const StatusIcon = config.icon;

  let statusText;
  if (status === "online" && time) {
    statusText = `Uptime: ${time}`;
  } else if (status === "offline" && time) {
    statusText = `Downtime: ${time}`;
  } else if (status === "warning" && warningMessage) {
    statusText = warningMessage;
  }

  return (
    <div className="pop-in flex-1 mx-1.25 bg-secondary text-primary rounded-3xl p-5 motion-safe:transition hover:scale-[1.02] self-start">
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-pill bg-primary text-secondary flex items-center justify-center">
          <Icon size={22} aria-hidden="true" />
        </div>
        <div className="text-left">
          <div className="font-mono font-normal">{name}</div>
        </div>
      </div>

      <div
        className="h-1 bg-primary rounded-pill mx-1 my-4"
        aria-hidden="true"
      />

      <div className="text-left">
        <div className={`text-sm ${config.color}`}>Status</div>
        {statusText && (
          <div className="flex items-center gap-1 text-sm ml-2.5">
            <StatusIcon size={14} className={config.color} aria-hidden="true" />
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
              aria-hidden="true"
            >
              <circle
                cx="7"
                cy="7"
                r="5"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeOpacity="0.3"
              />
              <circle
                cx="7"
                cy="7"
                r="5"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                transform="rotate(-90 7 7)"
                strokeDasharray={`${(resourceUsage / 100) * 31.4} 31.4`}
              />
            </svg>
            <span className={config.color}>{resourceUsage}%</span>
          </div>
        )}
      </div>

      <button
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        className="flex items-center gap-1 text-sm text-accent hover:text-primary mt-3 cursor-pointer"
        aria-expanded={isOpen}
        aria-controls={breakdownId}
      >
        <ChevronDown
          size={16}
          className={`motion-safe:transition-transform duration-200 ${isOpen ? "rotate-180" : "rotate-0"}`}
          aria-hidden="true"
        />
        <span>{isOpen ? "Hide breakdown" : "Show breakdown"}</span>
      </button>

      <div
        id={breakdownId}
        className={`motion-safe:transition-all duration-300 ease-out ${
          isOpen ? "max-h-96 overflow-visible" : "max-h-0 overflow-hidden"
        }`}
        aria-hidden={!isOpen}
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

export default memo(ServiceStatusCardInner);
