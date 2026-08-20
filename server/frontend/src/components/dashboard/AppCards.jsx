import { memo } from "react";
import { Link } from "react-router-dom";
import { Package, Cpu, MemoryStick, Clock, TrendingUp, ExternalLink, Settings, ArrowRight } from "lucide-react";
import Card from "../cards/Card";
import Button from "../ui/Button";
import CardButton from "../ui/CardButton";
import AppIcon from "../common/AppIcon";
import StatusPill from "../common/StatusPill";
import { useApps } from "../../hooks/useApps";
import { useIsNarrow } from "../../hooks/useIsNarrow";

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

/** @param {{ app: any }} _ */
function AppCardInner({ app }) {
  const [isNarrow, ref] = useIsNarrow(220);
  const isRunning = app.status === "running";
  const uptime = isRunning ? app.uptime_seconds : app.downtime_seconds;
  const appUrl = app.url || app.backends?.[0]?.url || "";
  const uptimeLabel = isRunning ? "Uptime" : "Downtime";

  return (
    <div ref={ref} className="self-start" data-slot="app-card">
    <Card noHeightAnim className="relative">
      <StatusPill status={app.status} compact={isNarrow} className="absolute top-3 right-3 z-10" />

      <div className="flex items-center gap-4">
        <AppIcon appId={app.app_id} size={48} />
        <div className="text-left min-w-0 flex-1">
          {appUrl ? (
            <a
              href={appUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${app.name} (opens in new tab)`}
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
          <Cpu size={14} className="text-primary/50" aria-hidden="true" />
          <span className="text-primary/70">CPU:</span>
          <span className="font-mono">
            {app.cpu_percent != null ? `${app.cpu_percent.toFixed(1)}%` : "-"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <MemoryStick size={14} className="text-primary/50" aria-hidden="true" />
          <span className="text-primary/70">RAM:</span>
          <span className="font-mono">
            {app.memory_usage != null ? formatBytes(app.memory_usage) : "-"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-primary/50" aria-hidden="true" />
          <span className="text-primary/70">{uptimeLabel}:</span>
          <span className="font-mono">{formatDuration(uptime)}</span>
        </div>
        <div className="flex items-center gap-2">
          <TrendingUp size={14} className="text-primary/50" aria-hidden="true" />
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
    </Card>
    </div>
  );
}

const AppCard = memo(AppCardInner);

function NoAppsCard() {
  return (
    <div className="xl:col-span-2 h-full">
      <Card
        noPopIn
        noHeightAnim
        padding={false}
        className="h-full flex flex-col items-center justify-center text-center py-12 px-6"
        data-slot="no-apps-card"
      >
        <div
          className="w-14 h-14 rounded-pill bg-primary/10 flex items-center justify-center mb-5"
          aria-hidden="true"
        >
          <Package size={22} className="text-primary/50" />
        </div>

        <h3 className="font-mono text-xl font-normal tracking-tight text-primary mb-2">
          No apps yet
        </h3>

        <p className="text-sm text-accent leading-relaxed max-w-md mb-6">
          Your server is ready for its first app. Pick one from the catalog —
          it'll be live in a couple of minutes.
        </p>

        <Button asChild variant="primary" size="md" className="font-mono">
          <Link to="/apps">
            Install an App <ArrowRight size={16} className="ml-1" />
          </Link>
        </Button>
      </Card>
    </div>
  );
}

/** @param {{ refreshInterval?: number }} _ */
export default function AppCards({ refreshInterval = 30000 }) {
  const { data: apps = [], isLoading, error } = useApps(refreshInterval);

  if (isLoading) {
    return (
      <Card className="self-start" data-slot="app-card-loading">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-pill bg-primary/10 flex items-center justify-center animate-pulse" aria-hidden="true">
            <Package size={22} className="text-primary/30" />
          </div>
          <div className="text-left">
            <div className="font-mono font-normal text-primary/50">Loading apps...</div>
          </div>
        </div>
      </Card>
    );
  }

  if (apps.length === 0) {
    return <NoAppsCard />;
  }

  if (error) {
    return (
      <Card className="self-start" data-slot="app-card-error">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-pill bg-primary/10 flex items-center justify-center" aria-hidden="true">
            <Package size={22} className="text-error" />
          </div>
          <div className="text-left">
            <div className="font-mono font-normal text-error">Failed to load apps</div>
            <div className="font-mono font-normal text-sm text-primary/50">{error.message}</div>
          </div>
        </div>
      </Card>
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