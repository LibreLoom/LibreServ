import { memo } from "react";
import PropTypes from "prop-types";
import { Activity, CheckCircle, AlertCircle, XCircle, HelpCircle } from "lucide-react";
import BaseCard from "./BaseCard";

const statusConfig = {
  healthy: {
    icon: CheckCircle,
    color: "text-success",
    bg: "bg-success/10",
    label: "Healthy",
  },
  unhealthy: {
    icon: XCircle,
    color: "text-error",
    bg: "bg-error/10",
    label: "Unhealthy",
  },
  warning: {
    icon: AlertCircle,
    color: "text-warning",
    bg: "bg-warning/10",
    label: "Warning",
  },
  unknown: {
    icon: HelpCircle,
    color: "text-secondary/50",
    bg: "bg-secondary/10",
    label: "Unknown",
  },
  not_configured: {
    icon: HelpCircle,
    color: "text-accent",
    bg: "bg-accent/10",
    label: "Not Configured",
  },
};

function HealthIndicator({ name, status }) {
  const config = statusConfig[status] || statusConfig.unknown;
  const StatusIcon = config.icon;

  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-primary">{name}</span>
      <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-pill ${config.bg}`}>
        <StatusIcon size={14} className={config.color} />
        <span className={`text-xs font-medium ${config.color}`}>{config.label}</span>
      </div>
    </div>
  );
}

function ResourceBar({ label, value, max = 100 }) {
  const percentage = Math.min(100, Math.round((value / max) * 100));
  const isWarning = percentage > 80;
  const isCritical = percentage > 95;

  const barColor = isCritical
    ? "bg-error"
    : isWarning
      ? "bg-warning"
      : "bg-accent";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-primary">{label}</span>
        <span className="font-mono text-secondary">{Math.round(value)}%</span>
      </div>
      <div className="h-2 bg-secondary/10 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-500 ease-out`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

function SystemHealthCardInner({ systemHealth, resources }) {
  const checks = systemHealth?.checks || {};
  const systemStatus = systemHealth?.status || "unknown";
  const config = statusConfig[systemStatus] || statusConfig.unknown;
  const StatusIcon = config.icon;

  const cpuPercent = resources?.cpu_percent || 0;
  const memoryPercent = resources?.memory_percent || 0;
  const diskPercent = resources?.disk_percent || 0;

  return (
    <BaseCard icon={Activity} title="System Health">
      <div className="flex items-center gap-2 mb-4">
        <StatusIcon size={20} className={config.color} />
        <span className={`text-sm font-medium ${config.color}`}>
          {config.label}
        </span>
      </div>

      <div className="space-y-1 mb-4">
        <HealthIndicator name="API Server" status={checks.api || "unknown"} />
        <HealthIndicator name="Database" status={checks.database || "unknown"} />
        <HealthIndicator name="Docker" status={checks.docker || "unknown"} />
        <HealthIndicator name="SMTP" status={checks.smtp || "not_configured"} />
      </div>

      <div className="pt-3 border-t border-secondary/10 space-y-3">
        <ResourceBar label="CPU" value={cpuPercent} />
        <ResourceBar label="Memory" value={memoryPercent} />
        <ResourceBar label="Disk" value={diskPercent} />
      </div>
    </BaseCard>
  );
}

export default memo(SystemHealthCardInner);

SystemHealthCardInner.propTypes = {  systemHealth: PropTypes.shape({
    status: PropTypes.string,
    checks: PropTypes.shape({
      api: PropTypes.string,
      database: PropTypes.string,
      docker: PropTypes.string,
      smtp: PropTypes.string,
    }),
  }),
  resources: PropTypes.shape({
    cpu_percent: PropTypes.number,
    memory_percent: PropTypes.number,
    disk_percent: PropTypes.number,
  }),
};
