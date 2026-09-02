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
import Pill from "../common/Pill";
import Button from "../ui/Button";

function formatBackend(backend) {
  if (!backend) return "N/A";
  try {
    // Bare host:port has no scheme — new URL() would misparse it as a
    // custom protocol, so normalize before parsing.
    const url = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(backend) ? backend : `http://${backend}`);
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
      data-slot="network-routes"
      icon={Globe}
      title="Network Routes"
      padding={false}
      headerActions={
        <Button
          variant="outline"
          size="sm"
          onClick={onAdd}
        >
          <Plus size={14} aria-hidden="true" />
          Add Route
        </Button>
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
            <Button onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : routes.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <span className="opacity-50 block mb-2"><Globe className="w-10 h-10 text-primary mx-auto" /></span>
            <p className="text-sm text-accent">No routes configured</p>
            <Button onClick={onAdd} className="mt-3">
              <Plus size={16} aria-hidden="true" />
              Add your first route
            </Button>
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
                      <div className="flex items-center justify-center bg-primary/10 rounded-large-element font-mono text-xs text-accent min-w-[28px] h-7 px-1.5">
                        {appName.slice(0, 2).toUpperCase()}
                      </div>
                    ) : (
                      <div className="rounded-large-element bg-primary/10 flex items-center justify-center" style={{ width: 28, height: 28 }}>
                        <span className="opacity-50"><HelpCircle size={16} className="text-primary" /></span>
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-primary truncate">
                        {formatFullDomain(route)}
                      </div>
                      <div className="text-xs text-accent mt-0.5 flex items-center gap-2">
                        <span>{appName || formatBackend(route.backend)}</span>
                        {route.ssl && (
                          <Pill variant="success" className="text-[10px] py-0">SSL</Pill>
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
                    <Button
                      variant="ghost"
                      size="iconSm"
                      onClick={() => onEdit(route)}
                      tooltip="Edit route"
                      aria-label="Edit route"
                    >
                      <span className="opacity-50"><Pencil size={14} className="text-accent" aria-hidden="true" /></span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="iconSm"
                      onClick={() => onDelete(route)}
                      tooltip="Delete route"
                      aria-label="Delete route"
                      className="hover:bg-error/10 hover:text-error"
                    >
                      <span className="opacity-50"><Trash2 size={14} className="text-accent" aria-hidden="true" /></span>
                    </Button>
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
