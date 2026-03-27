import { memo } from "react";
import { statusConfig } from "../../data/statusConfig";
import BaseCard from "./BaseCard";
import Expandable from "../ui/Expandable";
import Button from "../ui/Button";

function ServiceStatusCardInner({
  icon: Icon,
  name,
  status,
  time,
  warningMessage,
  resourceUsage,
  breakdownItems = [],
}) {
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
    <BaseCard icon={Icon} title={name}>
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

      {breakdownItems.length > 0 && (
        <Expandable label="Show breakdown" expandedLabel="Hide breakdown">
          <div className="grid grid-cols-2 gap-2 pt-4">
            {breakdownItems.map((item) => (
              <div key={item.label} className="text-sm">
                <div className="text-accent">{item.label}</div>
                <div className="font-mono">{item.value}</div>
              </div>
            ))}
          </div>
        </Expandable>
      )}

      <Button variant="secondary" className="w-full mt-4" onClick={() => window.location.href = `/apps/${name}`}>
        Manage
      </Button>
    </BaseCard>
  );
}

export default memo(ServiceStatusCardInner);
