import { statusConfig, normalizeResources } from "../../data/statusConfig";
import BaseCard from "./BaseCard";

function UsageBar({ percentage }) {
  const circumference = 31.4;

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="text-primary" aria-hidden="true">
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
        strokeDasharray={`${(percentage / 100) * circumference} ${circumference}`}
      />
    </svg>
  );
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
  const resourceList = normalizeResources(resources);

  let statusText;
  if (status === "online" && time) {
    statusText = `Uptime: ${time}`;
  } else if (status === "offline" && time) {
    statusText = `Downtime: ${time}`;
  } else if (status === "warning" && warningMessage) {
    statusText = warningMessage;
  }

  return (
    <BaseCard icon={Icon} title={name}>
      {statusText && (
        <div className="flex items-center gap-2 text-sm mb-4">
          <StatusIcon size={16} className={config.color} aria-hidden="true" />
          <span className={config.color}>{statusText}</span>
        </div>
      )}

      <div className={`text-primary text-sm font-medium ${config.color}`}>
        Resource Usage
      </div>
      <div className="space-y-3 mt-2">
        {resourceList.map((resource) => (
          <div
            key={resource.label}
            className="flex items-center gap-3 font-mono text-sm"
          >
            <UsageBar percentage={resource.value} />
            <span
              className="text-primary w-12 text-right"
              aria-label={`${resource.value}%`}
            >
              {resource.value}%
            </span>
            <span className="text-accent">{resource.label}</span>
          </div>
        ))}
      </div>
    </BaseCard>
  );
}
