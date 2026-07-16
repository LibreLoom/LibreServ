import { useCallback, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Dropdown from "../components/common/Dropdown";
import Button from "../components/ui/Button";
import AppIcon from "../components/common/AppIcon";
import StateOverlay from "../components/common/StateOverlay";
import { Search, Download, Check, Settings, Cpu, MemoryStick, Clock, TrendingUp, ExternalLink } from "lucide-react";
import StatusPill from "../components/common/StatusPill";
import { useApps } from "../hooks/useApps";
import { useCatalog } from "../hooks/useCatalog";
import FeatureMatrixPill from "../components/app/FeatureMatrixPill";
import { sanitizeURL } from "../lib/sanitize";
import { cn } from "@/lib/utils";

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

function AppCatalogCard({ app, isInstalled, onInstall, index }) {
  return (
    <div className="animate-alert-enter" style={{ animationDelay: `${index * 45}ms` }}>
    <Card className="relative flex flex-col h-full" noHeightAnim noPopIn>
      <div className="flex items-start gap-4">
        <AppIcon appId={app.id} size={48} className="flex-shrink-0" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-mono text-lg text-primary truncate">
              {app.name}
            </h3>
            {isInstalled && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-accent/20 text-secondary/80 text-xs font-mono">
                <Check size={12} />
                Installed
              </span>
            )}
          </div>
        </div>
      </div>

      <p className="text-sm text-primary/70 mt-3 line-clamp-2">
        {app.description}
      </p>

      {app.category && (
        <span className="mt-2 self-start px-2 py-1 rounded-large-element bg-secondary/10 text-xs font-mono text-primary/50 capitalize">
          {app.category}
        </span>
      )}

      <div className="flex-1" />

      <FeatureMatrixPill appId={app.id} className="mt-3" />

      {!isInstalled && (
        <Button
          variant="accent"
          fullWidth
          className="mt-4"
          onClick={() => onInstall(app.id)}
        >
          <Download size={16} />
          Install
        </Button>
      )}

      {isInstalled && (
        <Button
          variant="ghost"
          fullWidth
          disabled
          className="mt-4"
        >
          <Check size={16} />
          Already Installed
        </Button>
      )}
    </Card>
    </div>
  );
}

export default function AppsPage() {
  const navigate = useNavigate();

  const { data: catalog = [], isLoading: catalogLoading, error: catalogError } = useCatalog();
  const { data: installedApps = [], isLoading: appsLoading, error: appsError } = useApps();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");

  const loading = catalogLoading || appsLoading;
  const error = catalogError || appsError;

  const handleInstall = useCallback(
    (appId) => {
      navigate(`/apps/install/${appId}`);
    },
    [navigate],
  );

  const installedAppIds = new Set(installedApps.map((app) => app.app_id));

  const categories = [
    ...new Set(catalog.map((app) => app.category).filter(Boolean)),
  ];

  const filteredCatalog = catalog.filter((app) => {
    if (installedAppIds.has(app.id)) return false;

    const matchesSearch =
      !searchQuery ||
      app.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      app.description?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesCategory =
      !selectedCategory || app.category === selectedCategory;

    return matchesSearch && matchesCategory;
  });

  if (error) {
    return (
      <Page title="Apps" titleId="apps-title">
        <div className="mt-8 text-center">
          <p className="text-secondary/70">Failed to load app catalog. Please try again.</p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => window.location.reload()}
          >
            Try Again
          </Button>
        </div>
      </Page>
    );
  }

  return (
    <Page
      data-slot="apps-page"
      title="Apps"
      titleId="apps-title"
      className={cn(loading && "pop-out", !loading && "pop-in")}
    >
      {loading && (
        <StateOverlay message="Loading apps..." />
      )}

      <div className="mt-5 flex items-center bg-secondary text-primary rounded-pill whitespace-nowrap">
        <div className="relative flex-1 min-w-0">
          <Search
            size={18}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/40 pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search apps..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-11 pr-3 py-2.5 bg-transparent text-primary placeholder:text-primary/50 focus:outline-none no-focus-outline font-mono text-sm"
          />
        </div>

        {categories.length > 1 && (
          <div className="pr-1.5 py-1 shrink-0">
            <Dropdown
              ghost
              value={selectedCategory}
              onChange={setSelectedCategory}
              placeholder="All Categories"
              options={[
                { value: "", label: "All Categories" },
                ...categories.map((cat) => {
                  const LABELS = { ai: "AI", seo: "SEO" };
                  return {
                    value: cat,
                    label: LABELS[cat] || (cat.charAt(0).toUpperCase() + cat.slice(1)),
                  };
                }),
              ]}
              className="shrink-0"
            />
          </div>
        )}
      </div>

      {filteredCatalog.length === 0 && !loading && (
        <div className="mt-12 text-center">
          <p className="text-secondary/70">
            {searchQuery || selectedCategory
              ? "No apps match your search."
              : "No apps available."}
          </p>
        </div>
      )}
      {filteredCatalog.length > 0 && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredCatalog.map((app, index) => (
            <AppCatalogCard
              key={app.id}
              app={app}
              index={index}
              isInstalled={installedAppIds.has(app.id)}
              onInstall={handleInstall}
            />
          ))}
        </div>
      )}

      {installedApps.length > 0 && (
        <section className="mt-10" aria-label="Installed apps">
          <h2 className="text-xl font-mono font-normal mb-4 text-secondary">
            Installed Apps
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {installedApps.map((app) => {
              const isRunning = app.status === "running";
              const uptime = isRunning ? app.uptime_seconds : app.downtime_seconds;
              const uptimeLabel = isRunning ? "Uptime" : "Downtime";
              const rawUrl = app.url || app.backends?.[0]?.url || "";
              const appUrl = sanitizeURL(rawUrl);

              return (
                <Card key={app.id} className="relative flex flex-col">
                  <StatusPill status={app.status} className="absolute top-3 right-3" />
                  <div className="flex items-start gap-4">
                    <AppIcon appId={app.app_id} size={48} className="shrink-0" />
                    <div className="flex-1 min-w-0">
                      {appUrl ? (
                        <a
                          href={appUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-lg text-primary truncate pr-20 hover:text-accent transition-colors block"
                          aria-label={`${app.name} (opens in new tab)`}
                        >
                          {app.name}
                        </a>
                      ) : (
                        <h3 className="font-mono text-lg text-primary truncate pr-20">
                          {app.name}
                        </h3>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm mt-4 text-primary/80">
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

                  <div className="mt-auto pt-4 flex gap-2">
                    <Button
                      variant="accent"
                      className="flex-1"
                      onClick={() => navigate(`/apps/${app.id}`)}
                    >
                      <Settings size={16} />
                      Manage
                    </Button>
                    {appUrl && (
                      <Button
                        variant="outline"
                        surface="secondary"
                        aria-label={`${app.name} (opens in new tab)`}
                        onClick={() => window.open(appUrl, "_blank", "noopener,noreferrer")}
                      >
                        <ExternalLink size={16} aria-hidden="true" />
                        Open
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      )}
    </Page>
  );
}
