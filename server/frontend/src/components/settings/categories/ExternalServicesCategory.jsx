import { cn } from "@/lib/utils";
import { useState } from "react";
import {
  Mail,
  Globe,
  Database,
  Waypoints,
  Sparkles,
} from "lucide-react";
import SettingsCard from "../SettingsCard.jsx";
import ConnectStatusCard from "../../connect/ConnectStatusCard.jsx";
import EmailServiceModal from "../../connect/EmailServiceModal.jsx";
import DomainServiceModal from "../../connect/DomainServiceModal.jsx";
import BackupServiceModal from "../../connect/BackupServiceModal.jsx";
import TunnelServiceModal from "../../connect/TunnelServiceModal.jsx";
import AIServiceModal from "../../connect/AIServiceModal.jsx";

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

const STATE_BADGES = {
  connected: { label: "Connected", class: "bg-accent text-primary" },
  byo: { label: "Bring Your Own", class: "bg-primary text-secondary border-2 border-accent/30" },
  disabled: { label: "Off", class: "bg-primary text-secondary/50 border-2 border-secondary/10" },
};

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

  const closeModal = () => setOpenModal(null);

  const handleActivate = async (key) => {
    if (onActivateConnect) {
      await onActivateConnect(key);
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
          connectKeyHint={connectStatus?.connect_key_hint}
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
        const badge = svc ? STATE_BADGES[svc.state] : STATE_BADGES.disabled;

        return (
          <div
            key={id}
            role="button"
            tabIndex={0}
            onClick={() => setOpenModal(id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenModal(id); } }}
            className="cursor-pointer focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 rounded-large-element"
          >
            <SettingsCard index={i} icon={Icon} title={title} padding={false}>
              <div className="px-5 py-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0 pr-4">
                    <p className="text-sm text-accent">{desc}</p>
                    {svc?.details && Object.keys(svc.details).length > 0 && (
                      <p className="text-xs text-accent/60 mt-1 font-mono truncate">
                        {Object.entries(svc.details).map(([k, v]) => `${k}: ${v}`).join(", ")}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={cn("text-xs px-2.5 py-1 rounded-pill font-medium", badge.class)}>
                      {badge.label}
                    </span>
                    <svg
                      width="16" height="16" viewBox="0 0 24 24"
                      fill="none" stroke="currentColor" strokeWidth="2"
                      className="text-accent"
                    >
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </div>
                </div>
              </div>
            </SettingsCard>
          </div>
        );
      })}

      <EmailServiceModal
        open={openModal === "smtp"}
        onClose={closeModal}
        onSaved={onRefreshConnectStatus}
        service={services?.smtp}
        connectStatus={connectStatus}
        csrfToken={csrfToken}
      />
      <DomainServiceModal
        open={openModal === "domain"}
        onClose={closeModal}
        onSaved={onRefreshConnectStatus}
        service={services?.domain}
        connectStatus={connectStatus}
        csrfToken={csrfToken}
      />
      <BackupServiceModal
        open={openModal === "backup"}
        onClose={closeModal}
        onSaved={onRefreshConnectStatus}
        service={services?.backup}
        repos={repos}
        connectStatus={connectStatus}
        csrfToken={csrfToken}
      />
      <TunnelServiceModal
        open={openModal === "tunnel"}
        onClose={closeModal}
        onSaved={onRefreshConnectStatus}
        service={services?.tunnel}
        connectStatus={connectStatus}
        csrfToken={csrfToken}
      />
      <AIServiceModal
        open={openModal === "ai"}
        onClose={closeModal}
        onSaved={onRefreshConnectStatus}
        service={services?.ai}
        connectStatus={connectStatus}
        aiSettings={aiSettings}
        csrfToken={csrfToken}
      />

    </div>
  );
}
