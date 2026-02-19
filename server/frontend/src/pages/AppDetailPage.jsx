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
  Server,
  Trash2,
  ExternalLink,
  Play,
  Square,
  RotateCw,
  Activity,
  Calendar,
  Folder,
  AlertTriangle,
  Loader2,
} from "lucide-react";

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
            This action <strong>cannot be undone</strong>. All data will be permanently deleted.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-primary/70">The following will be deleted:</p>
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
            className="w-full px-4 py-2 border-2 rounded-pill bg-primary text-secondary placeholder:text-primary/40 focus:outline-2 focus:outline-accent focus:outline-offset-2 border-primary/30 focus:border-accent"
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
            className="flex-1 px-4 py-2 rounded-pill bg-accent text-primary hover:bg-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
    [app, actionLoading, request]
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
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getStatusColor = (status) => {
    switch (status) {
      case "running":
        return "text-success";
      case "stopped":
        return "text-warning";
      case "error":
        return "text-error";
      default:
        return "text-primary/50";
    }
  };

  const getHealthColor = (health) => {
    switch (health) {
      case "healthy":
        return "text-success";
      case "unhealthy":
        return "text-error";
      default:
        return "text-primary/50";
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
      <header className="mb-10">
        <HeaderCard
          id="app-detail-title"
          title={app?.name || "App Details"}
          leftContent={
            app && (
              <AppIcon appId={app.app_id} size={40} className="mr-3" />
            )
          }
        />
      </header>

      {loading && showLoading && (
        <div className="fixed inset-0 flex items-center justify-center">
          <Card className="w-[70vw] sm:w-[20vw]">
            <div className="my-5 text-center" role="status" aria-live="polite">
              <p>Loading app...</p>
            </div>
          </Card>
        </div>
      )}

      {error && (
        <div className="fixed inset-0 flex items-center justify-center z-40">
          <Card className="w-[70vw] sm:w-[20vw] border-2 border-accent">
            <div className="my-5 text-center" role="status" aria-live="polite">
              <p className="text-accent">Error: {error}</p>
            </div>
          </Card>
        </div>
      )}

      {!loading && !error && app && (
        <>
          <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <Card className="motion-safe:transition hover:scale-[1.02]">
              <div className="flex items-center gap-3 mb-3">
                <Server size={20} className="text-accent" aria-hidden="true" />
                <h2 className="text-xl font-mono font-normal">Status</h2>
              </div>
              <p className={`text-lg ml-8 capitalize ${getStatusColor(app.status)}`}>
                {app.status}
              </p>
            </Card>

            <Card className="motion-safe:transition hover:scale-[1.02]">
              <div className="flex items-center gap-3 mb-3">
                <Activity size={20} className="text-accent" aria-hidden="true" />
                <h2 className="text-xl font-mono font-normal">Health</h2>
              </div>
              <p className={`text-lg ml-8 capitalize ${getHealthColor(app.health_status)}`}>
                {app.health_status || "Unknown"}
              </p>
            </Card>

            <Card className="motion-safe:transition hover:scale-[1.02]">
              <div className="flex items-center gap-3 mb-3">
                <Calendar size={20} className="text-accent" aria-hidden="true" />
                <h2 className="text-xl font-mono font-normal">Installed</h2>
              </div>
              <p className="text-lg ml-8">{formatDate(app.installed_at)}</p>
            </Card>
          </section>

          <section className="mt-6">
            <Card className="bg-primary! text-secondary! border-2! border-secondary!">
              <h2 className="text-2xl font-mono font-normal mb-6">Actions</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 items-stretch">
                {app.url && (
                  <a
                    href={app.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block"
                  >
                    <CardButton
                      action="#"
                      actionLabel="Open App"
                      variant="inverted"
                    />
                  </a>
                )}

                <div
                  onClick={() => app.status === "stopped" && handleAppAction("start")}
                  className={app.status !== "stopped" ? "opacity-50 cursor-not-allowed" : ""}
                >
                  <CardButton
                    action="#"
                    actionLabel={actionLoading === "start" ? "Starting..." : "Start"}
                    variant="inverted"
                  />
                </div>

                <div
                  onClick={() => app.status === "running" && handleAppAction("stop")}
                  className={app.status !== "running" ? "opacity-50 cursor-not-allowed" : ""}
                >
                  <CardButton
                    action="#"
                    actionLabel={actionLoading === "stop" ? "Stopping..." : "Stop"}
                    variant="inverted"
                  />
                </div>

                <div onClick={() => handleAppAction("restart")}>
                  <CardButton
                    action="#"
                    actionLabel={actionLoading === "restart" ? "Restarting..." : "Restart"}
                    variant="inverted"
                  />
                </div>

                <div onClick={() => setShowUninstallModal(true)} className="lg:col-span-4">
                  <CardButton
                    action="#"
                    actionLabel="Uninstall"
                    variant="danger"
                  />
                </div>
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
