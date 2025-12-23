import { CheckCircle, XCircle, AlertCircle } from "lucide-react";

const statusConfig = {
  online: {
    icon: CheckCircle,
    color: "text-green-500",
    bg: "bg-green-500/20",
    label: "Online",
  },
  offline: {
    icon: XCircle,
    color: "text-red-500",
    bg: "bg-red-500/20",
    label: "Offline",
  },
  warning: {
    icon: AlertCircle,
    color: "text-yellow-500",
    bg: "bg-yellow-500/20",
    label: "Warning",
  },
};

export default function ServiceStatusCard({
  icon: Icon,
  name,
  status,
  detail,
}) {
  const config = statusConfig[status] || statusConfig.offline;
  const StatusIcon = config.icon;

  return (
    <div className="bg-secondary text-primary rounded-large-element p-5 flex items-center justify-between motion-safe:transition hover:scale-[1.02]">
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-pill bg-primary text-secondary flex items-center justify-center">
          <Icon size={22} />
        </div>
        <div>
          <div className="text-left font-semibold">{name}</div>
          {detail && <div className="text-sm opacity-60">{detail}</div>}
        </div>
      </div>
      <div
        className={`flex items-center gap-2 px-3 py-1.5 rounded-pill ${config.bg}`}
      >
        <StatusIcon size={16} className={config.color} />
        <span className={`text-sm font-medium ${config.color}`}>
          {config.label}
        </span>
      </div>
    </div>
  );
}
