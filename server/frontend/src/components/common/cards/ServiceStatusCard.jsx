import {
  CheckCircle,
  XCircle,
  AlertCircle,
  ChevronUp,
  ChevronDown,
  Circle,
} from "lucide-react";
import CardButton from "./CardButton";

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
}) {
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
    <div className="max-w-90 bg-secondary text-primary rounded-large-element p-5 motion-safe:transition hover:scale-[1.02]">
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
            <Circle size={14} className={config.color} />
            <span className={config.color}>{resourceUsage + "%"}</span>
          </div>
        )}
      </div>
      <CardButton action="/apps" actionLabel="Manage" />
    </div>
  );
}
