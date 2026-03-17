import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../hooks/useAuth";
import HeaderCard from "../components/common/cards/HeaderCard";
import Card from "../components/common/cards/Card";
import CardButton from "../components/common/cards/CardButton";
import ModalCard from "../components/common/cards/ModalCard";
import ObjectNotFound from "./ObjectNotFound";
import AppIcon from "../components/common/AppIcon";
import api from "../lib/api";
import {
  Grid2X2,
  Trash2,
  ExternalLink,
  Play,
  Square,
  RotateCw,
  Folder,
  Server,
  AlertTriangle,
  Loader2,
  Activity,
  Cpu,
  HardDrive,
  ArrowUpCircle,
  CheckCircle,
  XCircle,
} from "lucide-react";
import StatusPill from "../components/common/StatusPill";

function UninstallConfirmModal({ app, onConfirm, onCancel, isUninstalling }) {
  const [typedName, setTypedName] = useState("");
  const appName = app?.name || "";
  const matches = typedName === appName;

  return (
    <ModalCard title="Uninstall App" onClose={onCancel}>
      <div className="space-y-4">
        <div className="flex items-center gap-3 p-3 bg-accent/10 rounded-large-element border border-accent/30">
          <AlertTriangle className="text-accent shrink-0" size={24} />
          <p className="text-sm">
            This action <strong>cannot be undone</strong>. All data will be
            permanently deleted.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-primary/70">
            The following will be deleted:
          </p>
          <ul className="text-sm space-y-1 ml-4">
            <li className="flex items-center gap-2">
              <Folder size={14} className="text-primary/50" />
              <span>Container volumes and data</span>
            </li>
            <li className="flex items-center gap-2">
              <Server size={14} className="text-primary/50" />
              <span>Configuration files</span>
            </li>
            <li className="flex items-center gap-2">
              <Activity size={14} className="text-primary/50" />
              <span>Container images</span>
            </li>
          </ul>
        </div>

        <div>
          <label className="text-sm text-primary/70 block mb-2">
            Type <strong className="text-primary">{appName}</strong> to confirm:
          </label>
           <input
             type="text"
             value={typedName}
             onChange={(e) => setTypedName(e.target.value)}
             placeholder={`Type "${appName}"`}
             className="w-full px-4 py-2 border-2 rounded-pill bg-primary text-secondary placeholder:text-primary/40 focus:ring-2 focus:ring-accent focus:ring-offset-2 border-primary/30 focus:border-accent"
             disabled={isUninstalling}
             autoFocus
           />
        </div>

        <div className="flex gap-3 pt-2">
          <button
            onClick={onCancel}
            disabled={isUninstalling}
            className="flex-1 px-4 py-2 rounded-pill border-2 border-primary/30 text-primary hover:bg-primary/5 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!matches || isUninstalling}
            className="flex-1 px-4 py-2 rounded-pill bg-accent text-primary hover:bg-accent/80 motion-safe:transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isUninstalling ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Uninstalling...
              </>
            ) : (
              "Uninstall"
            )}
          </button>
        </div>
      </div>
    </ModalCard>
  );
}

export default function AppDetailPage() {
  const { instanceId } = useParams();
  const navigate = useNavigate();
  const { request } = useAuth();

  const [app, setApp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);
  const [showUninstallModal, setShowUninstallModal] = useState(false);
  const [isUninstalling, setIsUninstalling] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [_metricsLoading, setMetricsLoading] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState(null);

  useEffect(() => {
    if (!instanceId) {
      setNotFound(true);
      return;
    }

    let delayTimer;
    const fetchApp = async () => {
      try {
        delayTimer = setTimeout(() => {
          setShowLoading(true);
        }, 500);
        setError(null);
        setNotFound(false);
        const response = await request(`/apps/${instanceId}`);
        const data = await response.json();
        setApp(data);
      } catch (err) {
        const status = err?.cause?.status;
        if (status === 404) {
          setNotFound(true);
        } else {
          setError(err.message || "Failed to load app details");
        }
      } finally {
        clearTimeout(delayTimer);
        setShowLoading(false);
        setLoading(false);
      }
    };
    fetchApp();
    return () => clearTimeout(delayTimer);
  }, [instanceId, request]);

  useEffect(() => {
    if (!app?.id) return;
    const fetchMetrics = async () => {
      setMetricsLoading(true);
      try {
        const response = await request(`/apps/${app.id}/metrics`);
        if (response.ok) {
          const data = await response.json();
          setMetrics(data);
        }
      } catch {
        // Metrics not available, silently ignore
      } finally {
        setMetricsLoading(false);
      }
    };
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 30000);
    return () => clearInterval(interval);
  }, [app?.id, request]);

  useEffect(() => {
    if (!app?.app_id) return;
    const checkUpdates = async () => {
      try {
        const response = await request(`/apps/updates/available`);
        if (response.ok) {
          const updates = await response.json();
          const update = updates?.updates?.find(
            (u) => u.instance_id === app.id
          );
          setAvailableUpdate(update || null);
        }
      } catch {
        // Silently ignore
      }
    };
    checkUpdates();
  }, [app?.id, app?.app_id, request]);

  const handleAppAction = useCallback(
    async (action) => {
      if (!app || actionLoading) return;
      setActionLoading(action);
      try {
        await request(`/apps/${app.id}/${action}`, { method: "POST" });
        const response = await request(`/apps/${app.id}`);
        const data = await response.json();
        setApp(data);
      } catch (err) {
        setError(err.message || `Failed to ${action} app`);
      } finally {
        setActionLoading(null);
      }
    },
    [app, actionLoading, request],
  );

  const handleUninstall = useCallback(async () => {
    if (!app || isUninstalling) return;
    setIsUninstalling(true);
    try {
      const csrfResponse = await api("/auth/csrf");
      const csrfData = await csrfResponse.json();

      await request(`/apps/${app.id}`, {
        method: "DELETE",
        headers: {
          "X-CSRF-Token": csrfData.csrf_token,
        },
      });
      navigate("/apps");
    } catch (err) {
      setError(err.message || "Failed to uninstall app");
      setShowUninstallModal(false);
    } finally {
      setIsUninstalling(false);
    }
  }, [app, isUninstalling, request, navigate]);

  const formatDate = (dateString) => {
    if (!dateString) return "Unknown";
    const date = new Date(dateString);
    return date.toLocaleDateString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  };

  const formatBytes = (bytes, decimals = 2) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (
      parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i]
    );
  };

  const formatPercent = (value) => {
    if (value === undefined || value === null) return "N/A";
    return `${value.toFixed(1)}%`;
  };

  const getStatusColor = (status) => {
    switch (status) {
      case "running":
        return "text-primary";
      case "stopped":
        return "text-primary/60";
      case "error":
        return "text-primary";
      default:
        return "text-primary/50";
    }
  };

  const getHealthColor = (health) => {
    switch (health) {
      case "healthy":
        return "text-primary";
      case "unhealthy":
        return "text-primary";
      default:
        return "text-primary/50";
    }
  };

  const getHealthIcon = (health) => {
    switch (health) {
      case "healthy":
        return <CheckCircle className="text-success" size={20} />;
      case "unhealthy":
        return <XCircle className="text-error" size={20} />;
      default:
        return <Activity className="text-primary/50" size={20} />;
    }
  };

  if (!loading && notFound) {
    return (
      <ObjectNotFound
        objectLabel="app"
        objectName={instanceId}
        backTo="/apps"
        backLabel="Apps"
        backIcon={Grid2X2}
      />
    );
  }

  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="app-detail-title"
      id="main-content"
      tabIndex={-1}
    >
      <header className="mb-8">
        <HeaderCard
          id="app-detail-title"
          title={app?.name || "App Details"}
          leftContent={
            app && <AppIcon appId={app.app_id} size={40} className="mr-3" />
          }
          rightContent={
            app && (
              <StatusPill status={app.status} className="relative !static" />
            )
          }
        />
      </header>

      {loading && showLoading && (
        <div className="fixed inset-0 flex items-center justify-center bg-primary/60 backdrop-blur-sm">
          <Card className="w-[70vw] sm:w-[20vw]">
            <div className="my-5 text-center" role="status" aria-live="polite">
              <p>Loading app...</p>
            </div>
          </Card>
        </div>
      )}

      {error && (
        <div className="fixed inset-0 flex items-center justify-center z-40 bg-primary/60 backdrop-blur-sm">
          <Card className="w-[70vw] sm:w-[20vw] border-2 border-accent">
            <div className="my-5 text-center" role="status" aria-live="polite">
              <p className="text-accent">Error: {error}</p>
            </div>
          </Card>
        </div>
      )}

      {!loading && !error && app && (
        <>
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <Card className="flex flex-col items-center justify-center py-6 text-center">
              <p className="text-xs font-mono uppercase tracking-wider text-primary/50 mb-1">
                Status
              </p>
              <p
                className={`text-2xl font-mono capitalize ${getStatusColor(app.status)}`}
              >
                {app.status}
              </p>
            </Card>

            <Card className="flex flex-col items-center justify-center py-6 text-center">
              <p className="text-xs font-mono uppercase tracking-wider text-primary/50 mb-1">
                Health
              </p>
              <div className="flex items-center gap-2">
                {getHealthIcon(app.health_status)}
                <p
                  className={`text-2xl font-mono capitalize ${getHealthColor(app.health_status)}`}
                >
                  {app.health_status || "Unknown"}
                </p>
              </div>
            </Card>

            <Card className="flex flex-col items-center justify-center py-6 text-center">
              <p className="text-xs font-mono uppercase tracking-wider text-primary/50 mb-1">
                Installed
              </p>
              <p className="text-lg font-mono">
                {formatDate(app.installed_at)}
              </p>
            </Card>

            {app.url && (
              <Card className="flex flex-col items-center justify-center py-6 text-center">
                <p className="text-xs font-mono uppercase tracking-wider text-primary/50 mb-1">
                  Link
                </p>
                <a
                  href={app.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-lg font-mono text-accent hover:underline flex items-center gap-1"
                >
                  Open App
                  <ExternalLink size={14} />
                </a>
              </Card>
            )}
          </section>

          {metrics && (
            <section className="mb-8">
              <Card className="bg-primary! text-secondary! border-2! border-secondary!">
                <h2 className="text-2xl font-mono font-normal mb-6">Resource Usage</h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-full bg-secondary/20">
                      <Cpu size={24} className="text-accent" />
                    </div>
                    <div>
                      <p className="text-xs font-mono uppercase tracking-wider text-accent font-bold">
                        CPU
                      </p>
                      <p className="text-xl font-mono">
                        {formatPercent(metrics.cpu_percent)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-full bg-secondary/20">
                      <Activity size={24} className="text-accent" />
                    </div>
                    <div>
                      <p className="text-xs font-mono uppercase tracking-wider text-accent font-bold">
                        Memory
                      </p>
                      <p className="text-xl font-mono">
                        {formatBytes(metrics.memory_usage)} / {formatBytes(metrics.memory_limit)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-full bg-secondary/20">
                      <HardDrive size={24} className="text-accent" />
                    </div>
                    <div>
                      <p className="text-xs font-mono uppercase tracking-wider text-accent font-bold">
                        Network
                      </p>
                      <p className="text-xl font-mono">
                        {formatBytes(metrics.network_rx || 0)} / {formatBytes(metrics.network_tx || 0)}
                      </p>
                    </div>
                  </div>
                </div>
              </Card>
            </section>
          )}

          {availableUpdate && (
            <section className="mb-8">
              <Card className="bg-primary! text-secondary! border-2! border-accent!">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <ArrowUpCircle size={32} className="text-accent" />
                    <div>
                      <h2 className="text-xl font-mono font-normal">Update Available</h2>
                      <p className="text-sm text-primary/70">
                        {availableUpdate.current_version} to {availableUpdate.latest_version}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleAppAction("update")}
                    disabled={actionLoading}
                    className="flex items-center justify-center gap-2 px-6 py-3 rounded-pill bg-accent text-primary hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-mono"
                  >
                    {actionLoading === "update" ? (
                      <>
                        <Loader2 size={18} className="animate-spin" />
                        Updating...
                      </>
                    ) : (
                      <>
                        <ArrowUpCircle size={18} />
                        Update Now
                      </>
                    )}
                  </button>
                </div>
              </Card>
            </section>
          )}

          <section>
            <Card className="bg-primary! text-secondary! border-2! border-secondary!">
              <h2 className="text-2xl font-mono font-normal mb-6">Control</h2>

              <div className="flex flex-wrap gap-3">
                <button
                  onClick={() =>
                    app.status === "stopped" && handleAppAction("start")
                  }
                  disabled={app.status !== "stopped" || actionLoading}
                  className="flex items-center justify-center gap-2 px-6 py-3 rounded-pill bg-secondary text-primary hover:bg-secondary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-mono"
                >
                  {actionLoading === "start" ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <Play size={18} />
                  )}
                  {actionLoading === "start" ? "Starting..." : "Start"}
                </button>

                <button
                  onClick={() =>
                    app.status === "running" && handleAppAction("stop")
                  }
                  disabled={app.status !== "running" || actionLoading}
                  className="flex items-center justify-center gap-2 px-6 py-3 rounded-pill bg-secondary text-primary hover:bg-secondary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-mono"
                >
                  {actionLoading === "stop" ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <Square size={18} />
                  )}
                  {actionLoading === "stop" ? "Stopping..." : "Stop"}
                </button>

                <button
                  onClick={() => handleAppAction("restart")}
                  disabled={actionLoading}
                  className="flex items-center justify-center gap-2 px-6 py-3 rounded-pill border-2 border-accent text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-mono"
                >
                  {actionLoading === "restart" ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <RotateCw size={18} />
                  )}
                  {actionLoading === "restart" ? "Restarting..." : "Restart"}
                </button>

                <div className="flex-1" />

                <button
                  onClick={() => setShowUninstallModal(true)}
                  className="flex items-center justify-center gap-2 px-6 py-3 rounded-pill bg-error text-primary hover:opacity-80 transition-colors font-mono"
                >
                  <Trash2 size={18} />
                  Uninstall
                </button>
              </div>
            </Card>
          </section>
        </>
      )}

      {showUninstallModal && app && (
        <UninstallConfirmModal
          app={app}
          onConfirm={handleUninstall}
          onCancel={() => setShowUninstallModal(false)}
          isUninstalling={isUninstalling}
        />
      )}
    </main>
  );
}
