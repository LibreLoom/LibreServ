import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Dropdown from "../components/common/Dropdown";
import Button from "../components/ui/Button";
import AppIcon from "../components/common/AppIcon";
import EmptyState from "../components/common/EmptyState";
import StateOverlay from "../components/cards/StateOverlay";
import { Search, Download, Check, Settings, ExternalLink } from "lucide-react";
import LayeredPill from "../components/ui/LayeredPill";
import { statusConfig } from "../data/statusConfig";
import { useApps } from "../hooks/useApps";
import { useCatalog } from "../hooks/useCatalog";
import { sanitizeURL } from "../lib/sanitize";
import { cn } from "@/lib/utils";

// Status color for the layered pill's icon — mirrors StatusPill's tint mapping
// (success/warning/error/info) as plain text colors.
const STATUS_TEXT = {
  running: "text-success",
  stopped: "text-warning",
  error: "text-error",
  unknown: "text-accent",
};

function AppCatalogCard({ app, isInstalled, instance, onInstall, onManage, index }) {
  const appUrl = instance ? sanitizeURL(instance.url || instance.backends?.[0]?.url || "") : "";
  const statusConf = instance ? statusConfig[instance.status] || statusConfig.unknown : null;
  const StatusIcon = statusConf?.icon;

  return (
    <div className="animate-card-stagger" style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}>
    <Card className="relative flex flex-col h-full" noHeightAnim noPopIn>
      {instance && statusConf && (
        <LayeredPill
          mono
          className="absolute top-3 right-3"
          icon={<StatusIcon size={11} className={STATUS_TEXT[instance.status] || "text-accent"} />}
          actionIcon={<Check size={11} />}
          actionLabel="Installed"
        >
          {statusConf.label}
        </LayeredPill>
      )}
      <div className="flex items-start gap-4">
        <AppIcon appId={app.id} size={48} className="flex-shrink-0" />

        <div className="flex-1 min-w-0">
          <h3 className="font-mono text-lg text-primary truncate pr-48">
            {app.name}
          </h3>
        </div>
      </div>

      <p className="text-sm text-primary mt-3 line-clamp-2">
        {app.description}
      </p>

      {app.category && (
        <span className="mt-2 self-start px-2 py-1 rounded-large-element bg-primary/10 text-xs font-mono text-primary capitalize">
          {app.category}
        </span>
      )}

      <div className="flex-1" />

      {!isInstalled && (
        <Button
          variant="primary"
          fullWidth
          className="mt-4"
          onClick={() => onInstall(app.id)}
        >
          <Download size={16} />
          Install
        </Button>
      )}

      {isInstalled && instance && (
        <div className="mt-4 flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => onManage(instance.id)}
          >
            <Settings size={16} />
            Manage
          </Button>
          {appUrl && (
            <Button
              variant="outline"
              surface="secondary"
              aria-label={`Open ${app.name} (opens in new tab)`}
              onClick={() => window.open(appUrl, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink size={16} aria-hidden="true" />
              Open
            </Button>
          )}
        </div>
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
  const instanceByAppId = new Map(installedApps.map((app) => [app.app_id, app]));

  const categories = [
    ...new Set(catalog.map((app) => app.category).filter(Boolean)),
  ];

  const filteredCatalog = catalog
    .filter((app) => {
      const matchesSearch =
        !searchQuery ||
        app.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        app.description?.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesCategory =
        !selectedCategory || app.category === selectedCategory;

      return matchesSearch && matchesCategory;
    })
    .sort((a, b) => {
      const aInstalled = installedAppIds.has(a.id);
      const bInstalled = installedAppIds.has(b.id);
      if (aInstalled !== bInstalled) return aInstalled ? -1 : 1;
      return 0;
    });

  if (error) {
    return (
      <Page title="Apps" titleId="apps-title">
        <EmptyState
          title="Couldn't load apps"
          description="Failed to load the app catalog. Please try again."
          action={
            <Button
              variant="secondary"
              surface="primary"
              onClick={() => window.location.reload()}
            >
              Try Again
            </Button>
          }
        />
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

      {/* Nothing to search when the catalog is empty — but keep the bar
          up when a query simply has no matches, so it can be cleared. */}
      {catalog.length > 0 && (
        <div className="mt-5 flex items-center gap-1 bg-secondary text-primary rounded-pill p-1 whitespace-nowrap border-2 border-primary/20 focus-within:border-accent transition-colors">
          <div className="relative flex-1 min-w-0 bg-primary text-secondary rounded-pill">
            <Search
              size={18}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-accent pointer-events-none"
            />
            <input
              type="text"
              placeholder="Search apps..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search apps"
              className="w-full pl-11 pr-3 py-2.5 bg-transparent text-secondary placeholder:text-accent focus:outline-none no-focus-outline font-mono text-sm"
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
      )}

      {filteredCatalog.length === 0 && !loading && (
        <EmptyState
          className="mt-12"
          icon={Search}
          title={searchQuery || selectedCategory ? "No matches" : "No apps yet"}
          description={
            searchQuery || selectedCategory
              ? "No apps match your search."
              : "No apps are available to install right now."
          }
        />
      )}
      {filteredCatalog.length > 0 && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredCatalog.map((app, index) => (
            <AppCatalogCard
              key={app.id}
              app={app}
              index={index}
              instance={instanceByAppId.get(app.id)}
              isInstalled={installedAppIds.has(app.id)}
              onInstall={handleInstall}
              onManage={(id) => navigate(`/apps/${id}`)}
            />
          ))}
        </div>
      )}
    </Page>
  );
}
