import { memo } from "react";
import { Link } from "react-router-dom";
import { Package, Cpu, MemoryStick, Clock, TrendingUp, ExternalLink, Settings } from "lucide-react";
import CardButton from "./CardButton";
import AppIcon from "../common/AppIcon";
import StatusPill from "../common/StatusPill";
import { useApps } from "../../hooks/useApps";

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return "-";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${seconds}s`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let unitIndex = 0;
  let value = bytes;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function AppCardInner({ app }) {
  const isRunning = app.status === "running";
  const uptime = isRunning ? app.uptime_seconds : app.downtime_seconds;
  const appUrl = app.url || app.backends?.[0]?.url || "";
  const uptimeLabel = isRunning ? "Uptime" : "Downtime";

  return (
    <div className="pop-in flex-1 mx-1.25 bg-secondary text-primary rounded-3xl p-5 motion-safe:transition hover:scale-[1.02] self-start relative">
      <StatusPill status={app.status} className="absolute top-3 right-3 z-10" />

      <div className="flex items-center gap-4">
        <AppIcon appId={app.app_id} size={48} />
        <div className="text-left min-w-0 flex-1">
          {appUrl ? (
            <a
              href={appUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono font-normal truncate hover:text-accent transition-colors"
            >
              {app.name}
            </a>
          ) : (
            <div className="font-mono font-normal truncate">{app.name}</div>
          )}
        </div>
      </div>

      <div className="h-1 bg-primary rounded-pill mx-1 my-4" aria-hidden="true" />

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="flex items-center gap-2">
          <Cpu size={14} className="text-primary/50" />
          <span className="text-primary/70">CPU:</span>
          <span className="font-mono">
            {app.cpu_percent != null ? `${app.cpu_percent.toFixed(1)}%` : "-"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <MemoryStick size={14} className="text-primary/50" />
          <span className="text-primary/70">RAM:</span>
          <span className="font-mono">
            {app.memory_usage != null ? formatBytes(app.memory_usage) : "-"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-primary/50" />
          <span className="text-primary/70">{uptimeLabel}:</span>
          <span className="font-mono">{formatDuration(uptime)}</span>
        </div>
        <div className="flex items-center gap-2">
          <TrendingUp size={14} className="text-primary/50" />
          <span className="text-primary/70">Avail:</span>
          <span className="font-mono">
            {app.availability_pct != null ? `${app.availability_pct.toFixed(0)}%` : "-"}
          </span>
        </div>
      </div>

      {appUrl && (
        <div className="mt-4">
          <CardButton action={appUrl} actionLabel="Open App" external icon={ExternalLink} />
        </div>
      )}

      <CardButton action={`/apps/${app.id}`} actionLabel="Manage" icon={Settings} />
    </div>
  );
}

const AppCard = memo(AppCardInner);

function NoAppsCard() {
  return (
    <div className="pop-in flex-1 mx-1.25 bg-secondary text-primary rounded-3xl p-5 flex flex-col items-center text-center">
      <div className="flex items-center gap-4 mb-4">
        <div className="h-12 w-12 rounded-pill bg-primary/10 text-primary/30 flex items-center justify-center">
          <Package size={22} />
        </div>
        <div className="text-left">
          <div className="font-mono font-normal">No Apps Installed</div>
        </div>
      </div>

      <div className="h-1 w-full bg-primary rounded-pill mt-2 mb-4" aria-hidden="true" />

      <p className="text-sm text-primary/70 mb-6">
        When apps are installed, they will appear here.
      </p>

      <Link
        to="/apps"
        className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-primary text-secondary hover:ring-2 hover:ring-accent transition-all font-mono font-medium text-sm"
      >
        Install an App
      </Link>
    </div>
  );
}

export default function AppCards({ refreshInterval = 30000 }) {
  const { data: apps = [], isLoading, error } = useApps(refreshInterval);

  if (isLoading) {
    return (
      <div className="pop-in flex-1 mx-1.25 bg-secondary text-primary rounded-3xl p-5 self-start">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-pill bg-primary/10 flex items-center justify-center animate-pulse">
            <Package size={22} className="text-primary/30" />
          </div>
          <div className="text-left">
            <div className="font-mono font-normal text-primary/50">Loading apps...</div>
          </div>
        </div>
      </div>
    );
  }

  if (apps.length === 0) {
    return <NoAppsCard />;
  }

  if (error) {
    return (
      <div className="pop-in flex-1 mx-1.25 bg-secondary text-primary rounded-3xl p-5 self-start">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-pill bg-primary/10 flex items-center justify-center">
            <Package size={22} className="text-error" />
          </div>
          <div className="text-left">
            <div className="font-mono font-normal text-error">Failed to load apps</div>
            <div className="font-mono font-normal text-sm text-primary/50">{error.message}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {apps.map((app) => (
        <AppCard key={app.id} app={app} />
      ))}
    </>
  );
}
