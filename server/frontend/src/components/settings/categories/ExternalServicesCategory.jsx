import { useState } from "react";
import {
  Mail,
  Globe,
  Database,
  Waypoints,
  Sparkles,
  Loader2,
} from "lucide-react";
import SettingsCard from "../SettingsCard.jsx";
import Toggle from "../../common/Toggle.jsx";
import ConnectStatusCard from "../../connect/ConnectStatusCard.jsx";
import EmailServiceModal from "../../connect/EmailServiceModal.jsx";
import DomainServiceModal from "../../connect/DomainServiceModal.jsx";
import BackupServiceModal from "../../connect/BackupServiceModal.jsx";
import TunnelServiceModal from "../../connect/TunnelServiceModal.jsx";
import AIServiceModal from "../../connect/AIServiceModal.jsx";
import { updateConnectService } from "../../../lib/connect-api.js";

const SERVICE_META = [
  {
    id: "smtp", Icon: Mail, title: "Email / SMTP",
    desc: "Sends notifications, password resets, and alerts.",
  },
  {
    id: "domain", Icon: Globe, title: "Domain & DNS",
    desc: "Reach your apps at a domain name instead of an IP address.",
  },
  {
    id: "backup", Icon: Database, title: "Cloud Backup Storage",
    desc: "Where your backups are stored. Multiple destinations allowed.",
  },
  {
    id: "tunnel", Icon: Waypoints, title: "Tunnel",
    desc: "Access your server behind a firewall or CGNAT.",
  },
  {
    id: "ai", Icon: Sparkles, title: "AI Assistant",
    desc: "AI help managing your server.",
  },
];


export default function ExternalServicesCategory({
  connectStatus,
  settings,
  repos,
  onActivateConnect,
  onDeactivateConnect,
  onRefreshConnectStatus,
  onOpenPlanPage,
  loading = false,
  csrfToken = "",
}) {
  const [openModal, setOpenModal] = useState(null);
  const [toggling, setToggling] = useState(null); // service id being toggled

  const closeModal = () => setOpenModal(null);

  const handleToggle = async (serviceId, checked) => {
    setToggling(serviceId);
    try {
      await updateConnectService(serviceId, checked ? "connected" : "disabled", csrfToken);
      if (onRefreshConnectStatus) await onRefreshConnectStatus();
    } catch (err) {
      console.error("Failed to toggle service:", err);
    } finally {
      setToggling(null);
    }
  };

  const handleActivate = async (token) => {
    if (onActivateConnect) {
      await onActivateConnect(token);
    }
  };

  const services = connectStatus?.services || {};
  const aiSettings = settings?.ai_support || {};

  return (
    <div className="space-y-4" data-slot="external-services-category">
      <p className="text-sm text-accent px-1">
        A server needs a few things from the outside world — a way to send email,
        a domain name to reach it, and a place to store backups. Here are all the
        external services your server depends on, in one place.
      </p>

      <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
        <ConnectStatusCard
          connected={connectStatus?.connected}
          plan={connectStatus?.plan}
          tokenHint={connectStatus?.token_hint}
          services={services}
          onActivate={handleActivate}
          onDeactivate={onDeactivateConnect}
          onOpenPlanPage={onOpenPlanPage}
          loading={loading}
          noPopIn
        />
      </div>

      {SERVICE_META.map(({ id, Icon, title, desc }, i) => {
        const svc = services[id];
        const isConnected = svc?.state === "connected";
        const isBYO = svc?.state === "byo";
        const isUnavailable = svc?.state === "unavailable";
        const isTogglingThis = toggling === id;
        const connectReady = connectStatus?.connected;

        return (
          <SettingsCard key={id} index={i} icon={Icon} title={title} padding={false}>
            <div className="px-5 py-4">
              <div className="flex items-center justify-between gap-4">
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => setOpenModal(id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenModal(id); } }}
                >
                  <p className="text-sm text-accent">{desc}</p>
                  {isBYO && (
                    <p className="text-xs text-accent mt-1">
                      Using your own provider — click to manage
                    </p>
                  )}
                  {isConnected && svc?.details && Object.keys(svc.details).length > 0 && (
                    <p className="text-xs text-accent/60 mt-1 font-mono truncate">
                      {Object.entries(svc.details).map(([k, v]) => `${k}: ${v}`).join(", ")}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {isUnavailable ? (
                    <span className="text-xs text-accent/50 px-2.5 py-1 rounded-pill font-medium">
                      Not in your plan
                    </span>
                  ) : isBYO ? (
                    <span className="text-xs px-2.5 py-1 rounded-pill font-medium bg-primary text-secondary/50 border-2 border-secondary/10">
                      BYO
                    </span>
                  ) : isTogglingThis ? (
                    <Loader2 className="w-5 h-5 animate-spin text-accent" />
                  ) : (
                    <Toggle
                      checked={isConnected}
                      onChange={(checked) => handleToggle(id, checked)}
                      disabled={!connectReady || isTogglingThis}
                      surface="secondary"
                      aria-label={title}
                    />
                  )}
                </div>
              </div>
              {!connectReady && !isBYO && !isUnavailable && (
                <p className="text-xs text-accent/50 mt-2">
                  Connect to LibreServ Connect to enable this service.
                </p>
              )}
            </div>
          </SettingsCard>
        );
      })}

      <EmailServiceModal
        open={openModal === "smtp"}
        onClose={closeModal}
        service={services?.smtp}
        connectStatus={connectStatus}
        csrfToken={csrfToken}
      />
      <DomainServiceModal
        open={openModal === "domain"}
        onClose={closeModal}
        service={services?.domain}
        connectStatus={connectStatus}
        csrfToken={csrfToken}
      />
      <BackupServiceModal
        open={openModal === "backup"}
        onClose={closeModal}
        service={services?.backup}
        repos={repos}
        connectStatus={connectStatus}
        csrfToken={csrfToken}
      />
      <TunnelServiceModal
        open={openModal === "tunnel"}
        onClose={closeModal}
        service={services?.tunnel}
        connectStatus={connectStatus}
        csrfToken={csrfToken}
      />
      <AIServiceModal
        open={openModal === "ai"}
        onClose={closeModal}
        service={services?.ai}
        connectStatus={connectStatus}
        aiSettings={aiSettings}
        csrfToken={csrfToken}
      />

    </div>
  );
}
