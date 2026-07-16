import { useParams, useNavigate } from "react-router-dom";
import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "../hooks/useAuth";
import { useInvalidateApps } from "../hooks/useApps";
import { useAppDetail } from "../hooks/useAppDetail";
import { useAppMetrics } from "../hooks/useAppMetrics";
import { useAppUpdates } from "../hooks/useAppUpdates";
import { useAppActions } from "../hooks/useAppActions";
import { useDelayedLoading } from "../hooks/useDelayedLoading";
import { useTimeFormat } from "../hooks/useTimeFormat";
import { useCatalogFeatures } from "../hooks/useCatalogFeatures";
import HeaderCard from "../components/cards/HeaderCard";
import Card from "../components/cards/Card";
import MetricCard from "../components/cards/MetricCard";
import Page from "../components/ui/Page";
import Button from "../components/ui/Button";
import ModalCard from "../components/cards/ModalCard";
import ObjectNotFound from "./ObjectNotFound";
import AppIcon from "../components/common/AppIcon";
import StateOverlay from "../components/common/StateOverlay";
import { sanitizeURL } from "../lib/sanitize";
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
  Wrench,
  Settings,
  Terminal,
} from "lucide-react";
import StatusPill from "../components/common/StatusPill";
import { ActionCard } from "../components/app/actions/ActionCard";
import { ActionOptionsModal } from "../components/app/actions/ActionOptionsModal";
import { ExposedInfoCard } from "../components/app/ExposedInfoCard";
import FeatureMatrix from "../components/app/FeatureMatrix";
import LogsViewer from "../components/app/LogsViewer";
import RevocationBanner from "../components/app/RevocationBanner";
import AcknowledgeRevocationModal from "../components/app/AcknowledgeRevocationModal";
import AccessControlSection from "../components/app/AccessControlSection";
import ReconfigureModal from "../components/app/ReconfigureModal";
import { useQueryClient } from "@tanstack/react-query";

function UninstallConfirmModal({ app, onConfirm, onCancel, isUninstalling }) {
  const [typedName, setTypedName] = useState("");
  const appName = app?.name || "";
  const matches = typedName === appName;

  return (
    <ModalCard title="Uninstall App" onClose={onCancel}>
      <div className="space-y-4">
        <div className="flex items-center gap-3 p-3 bg-accent/10 rounded-large-element border border-accent/30">
          <AlertTriangle className="text-secondary/80 shrink-0" size={24} />
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
              <span>The app's data and saved files</span>
            </li>
            <li className="flex items-center gap-2">
              <Server size={14} className="text-primary/50" />
              <span>Configuration files</span>
            </li>
            <li className="flex items-center gap-2">
              <Activity size={14} className="text-primary/50" />
              <span>The app's program files</span>
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
             className="w-full px-4 py-2 border-2 rounded-pill bg-primary text-secondary placeholder:text-secondary/60 focus:ring-2 focus:ring-accent focus:ring-offset-2 border-primary/30 focus:border-accent"
             disabled={isUninstalling}
             autoFocus
           />
        </div>

        <div className="flex gap-3 pt-2">
          <Button
            variant="outline"
            surface="secondary"
            onClick={onCancel}
            disabled={isUninstalling}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            variant="accent"
            onClick={onConfirm}
            disabled={!matches || isUninstalling}
            loading={isUninstalling}
            className="flex-1"
          >
            {isUninstalling ? "Uninstalling..." : "Uninstall"}
          </Button>
        </div>
      </div>
    </ModalCard>
  );
}

export default function AppDetailPage() {
  const { instanceId } = useParams();
  const navigate = useNavigate();
  const { request } = useAuth();
  const invalidateApps = useInvalidateApps();
  const queryClient = useQueryClient();
  const { formatDateTime } = useTimeFormat();

  const { data: app, isLoading, error } = useAppDetail(instanceId);
  const notFound = /** @type {{ status?: number }} */ (/** @type {any} */ (error)?.cause)?.status === 404;
  const showLoading = useDelayedLoading(isLoading);

  const { data: catalogFeatures } = useCatalogFeatures(app?.app_id);
  const { data: metrics } = useAppMetrics(app?.id);
  const { data: availableUpdate } = useAppUpdates(app?.id);
  const { data: actions = [], isLoading: actionsLoading } = useAppActions(app?.id);

  const [showUninstallModal, setShowUninstallModal] = useState(false);
  const [isUninstalling, setIsUninstalling] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [selectedAction, setSelectedAction] = useState(null);
  const [showActionModal, setShowActionModal] = useState(false);
  const [showLogsViewer, setShowLogsViewer] = useState(false);
  const [showAckRevocationModal, setShowAckRevocationModal] = useState(false);
  const [showReconfigureModal, setShowReconfigureModal] = useState(false);
  const rawUrl = app?.url || app?.backends?.[0]?.url || "";
  const appUrl = sanitizeURL(rawUrl);

  const handleActionExecute = useCallback(
    async (actionName, options = {}) => {
      if (!app || actionLoading) return;
      setActionLoading(actionName);
      try {
        const response = await request(`/apps/${app.id}/actions/${actionName}/execute`, {
          method: "POST",
          body: JSON.stringify({ action: actionName, options }),
        });
        return await response.json();
      } catch (err) {
        if (err.cause?.response) {
          try {
            const errorData = await err.cause.response.json();
            return { error: errorData.error || errorData.message || err.message };
          } catch {
            return { error: err.message };
          }
        }
        return { error: err.message };
      } finally {
        setActionLoading(null);
      }
    },
    [app, actionLoading, request],
  );

  const handleAppAction = useCallback(
    async (action) => {
      if (!app || actionLoading) return;
      setActionLoading(action);
      try {
        await request(`/apps/${app.id}/${action}`, { method: "POST" });
        await queryClient.invalidateQueries({ queryKey: ["apps", instanceId] });
      } finally {
        setActionLoading(null);
      }
    },
    [app, actionLoading, request, instanceId, queryClient],
  );

  const handleUninstall = useCallback(async () => {
    if (!app || isUninstalling) return;
    setIsUninstalling(true);
    try {
      await request(`/apps/${app.id}`, { method: "DELETE" });
      invalidateApps();
      navigate("/apps");
    } finally {
      setIsUninstalling(false);
    }
  }, [app, isUninstalling, request, navigate, invalidateApps]);

  const formatDate = (dateString) => {
    if (!dateString) return "Unknown";
    return formatDateTime(dateString);
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

  if (notFound) {
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
    <Page
      data-slot="app-detail-page"
      title={app?.name || "App Details"}
      titleId="app-detail-title"
      leftContent={app && <AppIcon appId={app.app_id} size={40} className="mr-3" />}
      rightContent={app && <StatusPill status={app.status} />}
    >
      {showLoading && (
        <StateOverlay message="Loading app..." />
      )}

      {error && !notFound && (
        <StateOverlay kind="error">
          <p className="text-secondary/80">Error: {error.message}</p>
        </StateOverlay>
      )}

      {!isLoading && !error && app && (
        <>
          {app.revocation_notice && (
            <RevocationBanner
              notice={app.revocation_notice}
              appName={app.name}
              acknowledged={!!app.revocation_notice.acknowledged_at}
              onSeeDetails={() => setShowAckRevocationModal(true)}
            />
          )}

          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <MetricCard
              label="Status"
              value={app.status}
              valueClassName={cn("capitalize", getStatusColor(app.status))}
            />

            <MetricCard label="Health">
              <div className="flex items-center gap-2">
                {getHealthIcon(app.health_status)}
                <p
                  className={cn("text-2xl font-mono capitalize", getHealthColor(app.health_status))}
                >
                  {app.health_status || "Unknown"}
                </p>
              </div>
            </MetricCard>

            <MetricCard
              label="Installed"
              value={formatDate(app.installed_at)}
              valueClassName="text-lg"
            />

            {appUrl && (
              <MetricCard label="Link">
                <a
                  href={appUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open app (opens in new tab)"
                  className="text-lg font-mono link-accent-card flex items-center gap-1"
                >
                  Open App
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              </MetricCard>
            )}
          </section>

          {metrics && (
            <section className="mb-8">
              <Card surface="primary">
                <div className="flex items-center gap-2 mb-6">
                  <Server size={20} className="text-secondary/70" />
                  <h2 className="text-2xl font-mono font-normal">Resource Usage</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-full bg-secondary/20">
                      <Cpu size={24} className="text-secondary/70" />
                    </div>
                    <div>
                      <p className="text-xs font-mono uppercase tracking-wider text-secondary/80 font-bold">
                        CPU
                      </p>
                      <p className="text-xl font-mono">
                        {formatPercent(metrics.cpu_percent)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-full bg-secondary/20">
                      <Activity size={24} className="text-secondary/70" />
                    </div>
                    <div>
                      <p className="text-xs font-mono uppercase tracking-wider text-secondary/80 font-bold">
                        Memory
                      </p>
                      <p className="text-xl font-mono">
                        {formatBytes(metrics.memory_usage)} / {formatBytes(metrics.memory_limit)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-full bg-secondary/20">
                      <HardDrive size={24} className="text-secondary/70" />
                    </div>
                    <div>
                      <p className="text-xs font-mono uppercase tracking-wider text-secondary/80 font-bold">
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
              <Card surface="primary" className="border-accent">
                <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <ArrowUpCircle size={32} className="text-secondary/70" />
                  <div>
                    <h2 className="text-xl font-mono font-normal">Update Available</h2>
                    <p className="text-sm text-secondary/70">
                      {availableUpdate.current_version} to {availableUpdate.latest_version}
                    </p>
                    {availableUpdate.needs_config && availableUpdate.needs_config_reason && (
                      <p className="text-sm text-secondary/60 mt-1">
                        Needs setup: {availableUpdate.needs_config_reason}
                      </p>
                    )}
                    {availableUpdate.compose_template_changed && (
                      <p className="text-sm text-secondary/60 mt-1">
                        This update includes configuration changes.
                      </p>
                    )}
                    {!availableUpdate.digest_tracking_enabled && (
                      <p className="text-sm text-secondary/60 mt-1">
                        Updating will enable security verification for this app.
                      </p>
                    )}
                  </div>
                  </div>
                  <Button
                    variant="accent"
                    onClick={() => handleAppAction("update")}
                    disabled={actionLoading || availableUpdate.needs_config}
                    loading={actionLoading === "update"}
                  >
                    {actionLoading === "update" ? <Loader2 size={18} className="animate-spin" /> : <ArrowUpCircle size={18} />}
                    {availableUpdate.needs_config ? "Setup Required" : "Update Now"}
                  </Button>
                </div>
              </Card>
            </section>
          )}

          <section>
            <Card surface="primary">
              <div className="flex items-center gap-2 mb-6">
                <Settings size={20} className="text-secondary/70" />
                <h2 className="text-2xl font-mono font-normal">Control</h2>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  variant="secondary"
                  onClick={() =>
                    app.status === "stopped" && handleAppAction("start")
                  }
                  disabled={app.status !== "stopped" || actionLoading}
                  loading={actionLoading === "start"}
                >
                  {actionLoading === "start" ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}
                  {actionLoading === "start" ? "Starting..." : "Start"}
                </Button>

                <Button
                  variant="secondary"
                  onClick={() =>
                    app.status === "running" && handleAppAction("stop")
                  }
                  disabled={app.status !== "running" || actionLoading}
                  loading={actionLoading === "stop"}
                >
                  {actionLoading === "stop" ? <Loader2 size={18} className="animate-spin" /> : <Square size={18} />}
                  {actionLoading === "stop" ? "Stopping..." : "Stop"}
                </Button>

                <Button
                  variant="outline"
                  surface="primary"
                  onClick={() => handleAppAction("restart")}
                  disabled={actionLoading}
                  loading={actionLoading === "restart"}
                >
                  {actionLoading === "restart" ? <Loader2 size={18} className="animate-spin" /> : <RotateCw size={18} />}
                  {actionLoading === "restart" ? "Restarting..." : "Restart"}
                </Button>

                <Button
                  variant="outline"
                  surface="primary"
                  onClick={() => setShowLogsViewer(true)}
                >
                  <Terminal size={18} />
                  View Logs
                </Button>
                <Button
                  variant="outline"
                  surface="primary"
                  onClick={() => setShowReconfigureModal(true)}
                  disabled={actionLoading}
                  loading={actionLoading}
                >
                  <Settings size={18} />
                  Settings
                </Button>

                <div className="flex-1" />

                <Button
                  variant="danger"
                  onClick={() => setShowUninstallModal(true)}
                >
                  <Trash2 size={18} />
                  Uninstall
                </Button>
              </div>
            </Card>
          </section>

          {actions.length > 0 && (
            <section className="mt-8">
              <Card surface="primary">
                <div className="flex items-center gap-2 mb-6">
                  <Wrench size={20} className="text-secondary/70" />
                  <h2 className="text-2xl font-mono font-normal">Actions</h2>
                </div>

                {actionsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 size={24} className="animate-spin text-secondary/70" />
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {actions.map((action, index) => (
                      <ActionCard
                        key={action.name || action.label || `action-${index}`}
                        action={action}
                        onExecute={() => {
                          setSelectedAction(action);
                          if (action.name === "view-logs") {
                            setShowLogsViewer(true);
                            return;
                          }
                          setShowActionModal(true);
                        }}
                        disabled={actionLoading !== null}
                      />
                    ))}
                  </div>
                )}
              </Card>
            </section>
          )}

          <section className="mt-8">
            <Card surface="primary">
              <div className="flex items-center gap-2 mb-6">
                <Settings size={20} className="text-secondary/70" />
                <h2 className="text-2xl font-mono font-normal">Capabilities</h2>
              </div>
              <FeatureMatrix features={catalogFeatures} compact onPrimary />
            </Card>
          </section>

          {catalogFeatures && (
            <AccessControlSection
              instanceId={app.id}
              accessModel={catalogFeatures.access_model || "internal"}
              appName={app.name}
            />
          )}

          {app.exposed_info && Object.keys(app.exposed_info).length > 0 && (
            <ExposedInfoCard info={app.exposed_info} />
          )}
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

      {showActionModal && selectedAction && (
        <ActionOptionsModal
          action={selectedAction}
          onClose={() => {
            setShowActionModal(false);
            setSelectedAction(null);
          }}
          onExecute={handleActionExecute}
          actionLoading={actionLoading}
        />
      )}

      {showLogsViewer && (
        <LogsViewer
          app={app}
          onClose={() => setShowLogsViewer(false)}
        />
      )}

      {showAckRevocationModal && app && (
        <AcknowledgeRevocationModal
          app={app}
          onClose={() => setShowAckRevocationModal(false)}
          onAcknowledged={async () => {
            await queryClient.invalidateQueries({ queryKey: ["apps", instanceId] });
          }}
        />
      )}

      {showReconfigureModal && app && (
        <ReconfigureModal
          app={app}
          request={request}
          onClose={() => setShowReconfigureModal(false)}
          onSuccess={(updatedApp) => {
            queryClient.setQueryData(["apps", instanceId], updatedApp);
            setShowReconfigureModal(false);
            invalidateApps();
          }}
        />
      )}
    </Page>
  );
}