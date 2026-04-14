import {
  Globe,
  Plus,
  Loader2,
  Pencil,
  Trash2,
  HelpCircle,
} from "lucide-react";
import PropTypes from "prop-types";
import Card from "../cards/Card";
import Toggle from "../common/Toggle";
import StatusBadge from "../common/StatusBadge";

function formatBackend(backend) {
  if (!backend) return "N/A";
  try {
    const url = new URL(backend);
    return url.host;
  } catch {
    return backend;
  }
}

function formatFullDomain(route) {
  if (!route) return "";
  if (route.subdomain) return `${route.subdomain}.${route.domain}`;
  return route.domain || "";
}

export default function RoutesCard({
  routes,
  apps,
  loading,
  error,
  onRetry,
  onAdd,
  onEdit,
  onDelete,
  onToggle,
  togglingId,
}) {
  const appNameMap = {};
  if (Array.isArray(apps)) {
    for (const app of apps) {
      if (app?.id) {
        appNameMap[app.id] = app.name;
      }
    }
  }
  return (
    <Card
      icon={Globe}
      title="Network Routes"
      padding={false}
      headerActions={
        <button
          onClick={onAdd}
          className="flex items-center gap-1 text-xs text-accent hover:text-primary transition-colors"
        >
          <Plus size={14} aria-hidden="true" />
          Add Route
        </button>
      }
      className="animate-in fade-in slide-in-from-bottom-2"
    >
      <div
        key={loading ? "loading" : error ? "error" : routes.length === 0 ? "empty" : "list"}
        className="animate-in fade-in slide-in-from-bottom-2"
        style={{ animationDuration: "var(--motion-duration-medium2)" }}
      >
        {loading ? (
          <div className="px-4 py-6 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-accent" />
          </div>
        ) : error ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm text-error mb-3">{error}</p>
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-pill bg-primary/10 text-primary hover:bg-primary/20 transition-all font-mono text-sm"
            >
              Retry
            </button>
          </div>
        ) : routes.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <Globe className="w-10 h-10 text-primary/30 mx-auto mb-2" />
            <p className="text-sm text-accent">No routes configured</p>
            <button
              onClick={onAdd}
              className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-2 transition-all font-mono text-sm"
            >
              <Plus size={16} aria-hidden="true" />
              Add your first route
            </button>
          </div>
        ) : (
          <div className="divide-y divide-primary/10">
            {routes.map((route) => {
              const appName = appNameMap[route.app_id];
              return (
                <div
                  key={route.id}
                  className="px-4 py-3 flex items-center justify-between"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {appName ? (
                      <div className="flex items-center justify-center bg-primary/10 rounded-large-element font-mono text-xs text-primary/60 min-w-[28px] h-7 px-1.5">
                        {appName.slice(0, 2).toUpperCase()}
                      </div>
                    ) : (
                      <div className="rounded-large-element bg-primary/10 flex items-center justify-center" style={{ width: 28, height: 28 }}>
                        <HelpCircle size={16} className="text-primary/50" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-primary truncate">
                        {formatFullDomain(route)}
                      </div>
                      <div className="text-xs text-accent mt-0.5 flex items-center gap-2">
                        <span>{appName || formatBackend(route.backend)}</span>
                        {route.ssl && (
                          <StatusBadge variant="success" className="text-[10px] py-0">SSL</StatusBadge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Toggle
                      checked={route.enabled}
                      onChange={() => onToggle(route)}
                      disabled={togglingId === route.id}
                    />
                    <button
                      onClick={() => onEdit(route)}
                      title="Edit route"
                      className="p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                      aria-label="Edit route"
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                    <button
                      onClick={() => onDelete(route)}
                      title="Delete route"
                      className="p-1.5 rounded-pill hover:bg-error/10 text-accent/50 hover:text-error transition-all"
                      aria-label="Delete route"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

RoutesCard.propTypes = {
  routes: PropTypes.array.isRequired,
  apps: PropTypes.array,
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func,
  onAdd: PropTypes.func,
  onEdit: PropTypes.func,
  onDelete: PropTypes.func,
  onToggle: PropTypes.func,
  togglingId: PropTypes.string,
};
