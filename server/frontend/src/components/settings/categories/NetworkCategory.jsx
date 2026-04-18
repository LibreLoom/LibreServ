import { useCallback, useEffect, useMemo, useState } from "react";
import { Server, Trash2 } from "lucide-react";
import PropTypes from "prop-types";
import ConfirmModal from "../../common/ConfirmModal";
import SettingsCard from "../SettingsCard";
import RoutesCard from "../../backups/RoutesCard";
import DebugCard from "../../backups/DebugCard";
import RouteModal from "../RouteModal";

import DomainManagementCard from "./DomainManagementCard";
import ValueDisplay from "../../common/ValueDisplay";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";
import { getCaddyStatus, listRoutes, getCaddyfile } from "../../../lib/network-api";

export default function NetworkCategory({ settings }) {
  const { request } = useAuth();
  const { addToast } = useToast();
  const [routes, setRoutes] = useState([]);
  const [caddyStatus, setCaddyStatus] = useState(null);
  const [apps, setApps] = useState(null);
  const [caddyfileContent, setCaddyfileContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [routeModalOpen, setRouteModalOpen] = useState(false);
  const [routeModalMode, setRouteModalMode] = useState("create");
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [routeToDelete, setRouteToDelete] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [togglingId, setTogglingId] = useState(null);

  const defaultDomain = useMemo(() => settings?.proxy?.default_domain || "", [settings]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [routesData, statusData, appsData, caddyData] = await Promise.all([
        listRoutes(),
        getCaddyStatus(),
        request("/apps").then((r) => r.json()).catch(() => []),
        getCaddyfile().catch(() => ""),
      ]);
      setRoutes(Array.isArray(routesData) ? routesData : []);
      setCaddyStatus(statusData);
      setApps(Array.isArray(appsData?.apps) ? appsData.apps : []);
      setCaddyfileContent(caddyData || "");
    } catch (err) {
      setApps([]);
      setLoadError(err.message || "Failed to load network data");
    } finally {
      setLoading(false);
    }
  }, [request]);

  const loadCaddyfile = useCallback(async () => {
    try {
      const content = await getCaddyfile();
      setCaddyfileContent(content);
    } catch {
      // silent fail on reload
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleAddRoute = useCallback(() => {
    setSelectedRoute(null);
    setRouteModalMode("create");
    setRouteModalOpen(true);
  }, []);

  const handleEditRoute = useCallback((route) => {
    setSelectedRoute(route);
    setRouteModalMode("edit");
    setRouteModalOpen(true);
  }, []);

  const handleDeleteClick = useCallback((route) => {
    setRouteToDelete(route);
    setDeleteModalOpen(true);
  }, []);

  const handleRouteSuccess = useCallback(() => {
    loadData();
  }, [loadData]);

  const handleToggleEnabled = useCallback(async (route) => {
    const originalRoutes = [...routes];
    setTogglingId(route.id);
    setRoutes((prev) =>
      prev.map((r) => (r.id === route.id ? { ...r, enabled: !r.enabled } : r))
    );
    try {
      const response = await request(`/network/routes/${route.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: route.backend, ssl: route.ssl, enabled: !route.enabled }),
      });
      if (response.ok) {
        addToast({
          type: "success",
          message: `${route.subdomain ? `${route.subdomain}.${route.domain}` : route.domain} ${!route.enabled ? "enabled" : "disabled"}`,
        });
      } else {
        setRoutes(originalRoutes);
        addToast({ type: "error", message: "Failed to update route" });
      }
    } catch {
      setRoutes(originalRoutes);
      addToast({ type: "error", message: "Failed to update route" });
    } finally {
      setTogglingId(null);
    }
  }, [request, routes, addToast]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!routeToDelete) return;
    setDeleteLoading(true);
    try {
      const response = await request(`/network/routes/${routeToDelete.id}`, {
        method: "DELETE",
      });
      if (response.ok) {
        setDeleteModalOpen(false);
        setRouteToDelete(null);
        loadData();
        addToast({ type: "success", message: "Route deleted" });
      } else {
        const data = await response.json().catch(() => ({}));
        addToast({ type: "error", message: data.message || "Failed to delete route" });
      }
    } catch {
      addToast({ type: "error", message: "Failed to delete route" });
    } finally {
      setDeleteLoading(false);
    }
  }, [routeToDelete, request, loadData, addToast]);

  const appLinkedRoute = routeToDelete?.app_id
    ? apps?.find((a) => a.id === routeToDelete.app_id)?.name
    : null;

  return (
    <div className="space-y-6">
      {caddyStatus && (
        <SettingsCard icon={Server} title="Caddy Status" index={0}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <ValueDisplay
              label="Status"
              value={
                caddyStatus.running
                  ? <span className="text-success">Running</span>
                  : <span className="text-error">Stopped</span>
              }
              mono={false}
            />
            <ValueDisplay label="Version" value={caddyStatus.version || "N/A"} />
            <ValueDisplay
              label="Config"
              value={
                caddyStatus.config_valid
                  ? <span className="text-success">Valid</span>
                  : <span className="text-warning">Invalid</span>
              }
            />
            <ValueDisplay label="Routes" value={String(caddyStatus.routes || routes.length)} />
            <ValueDisplay label="Domains" value={String(caddyStatus.domains?.length || 0)} />
          </div>
        </SettingsCard>
      )}

      <DomainManagementCard
        currentDomain={defaultDomain}
        onDomainChange={() => window.location.reload()}
      />

      <RoutesCard
        routes={routes}
        apps={apps}
        loading={loading}
        error={loadError}
        onRetry={loadData}
        onAdd={handleAddRoute}
        onEdit={handleEditRoute}
        onDelete={handleDeleteClick}
        onToggle={handleToggleEnabled}
        togglingId={togglingId}
      />

      <DebugCard content={caddyfileContent} onReload={loadCaddyfile} />

      <RouteModal
        open={routeModalOpen}
        onClose={() => setRouteModalOpen(false)}
        mode={routeModalMode}
        route={selectedRoute}
        defaultDomain={defaultDomain}
        apps={apps}
        onSuccess={handleRouteSuccess}
      />

      <ConfirmModal
        open={deleteModalOpen}
        onClose={() => { setDeleteModalOpen(false); setRouteToDelete(null); }}
        onConfirm={handleDeleteConfirm}
        icon={Trash2}
        title="Delete Route"
        message={routeToDelete
          ? `Delete route for ${routeToDelete.subdomain ? `${routeToDelete.subdomain}.${routeToDelete.domain}` : routeToDelete.domain}?`
          : ""}
        variant="danger"
        confirmLabel="Delete"
        loading={deleteLoading}
      >
        {appLinkedRoute && (
          <div className="mt-3 bg-warning/10 border border-warning/30 rounded-card p-3">
            <p className="font-mono text-xs text-warning">
              This route was automatically created for <strong>{appLinkedRoute}</strong>. Deleting it may make the app inaccessible.
            </p>
          </div>
        )}
      </ConfirmModal>
    </div>
  );
}

NetworkCategory.propTypes = {
  settings: PropTypes.object,
};
