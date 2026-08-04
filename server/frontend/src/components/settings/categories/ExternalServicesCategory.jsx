import { cn } from "@/lib/utils";
import { useState } from "react";
import {
  Mail,
  Globe,
  Database,
  Waypoints,
  Sparkles,
  LifeBuoy,
} from "lucide-react";
import SettingsCard from "../SettingsCard.jsx";
import ConnectStatusCard from "../../connect/ConnectStatusCard.jsx";
import EmailServiceModal from "../../connect/EmailServiceModal.jsx";
import DomainServiceModal from "../../connect/DomainServiceModal.jsx";
import BackupServiceModal from "../../connect/BackupServiceModal.jsx";
import TunnelServiceModal from "../../connect/TunnelServiceModal.jsx";
import AIServiceModal from "../../connect/AIServiceModal.jsx";

function formatGB(value) {
  if (value === 0) return null;
  if (value >= 1024) return `${(value / 1024).toLocaleString()} TB`;
  return `${value} GB`;
}

function formatBandwidth(mbps) {
  if (mbps === 0) return null;
  if (mbps >= 100) return "Full speed";
  return `${mbps} Mbps`;
}

function formatEmailPerMo(value) {
  if (value === 0) return null;
  return `${value.toLocaleString()} emails/mo`;
}

function formatAIMessages(value) {
  if (value === 0) return null;
  return `${value.toLocaleString()} messages/day`;
}

function formatTunnel(limits) {
  const speed = formatBandwidth(limits?.tunnel_mbps);
  const data = formatGB(limits?.tunnel_gb_per_mo);
  if (!speed && !data) return null;
  if (speed && data) return `${speed} · ${data}/mo`;
  return speed || `${data}/mo`;
}

function domainStatusLabel(status) {
  if (status === "active") return "Active";
  if (status === "grace") return "Grace period";
  if (status === "cancelled") return "Cancelled";
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : null;
}

function formatExpiry(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// Returns either a single short label for the "Included" pill, or null if
// the service isn't included on the current plan. For domain we prefer the
// server's actual configured domain (possibly a custom one with renewal
// info) over the plan wildcard. The wildcard is the final fallback.
function formatServiceLimit(serviceId, planLimits, svc) {
  if (!planLimits) return "—";

  switch (serviceId) {
    case "smtp":
      return formatEmailPerMo(planLimits.max_emails_per_day) || "Not in plan";
    case "domain": {
      // Custom domains replace the plan wildcard in the pill; a provisioned
      // subdomain is shown separately as the device's actual name.
      const isCustom = svc?.details?.type === "custom";
      if (isCustom) return svc.details.domain;
      return planLimits.domain || "Not in plan";
    }
    case "backup":
      return formatGB(planLimits.backup_gb) || "Not in plan";
    case "tunnel":
      return formatTunnel(planLimits) || "Not in plan";
    case "ai":
      return formatAIMessages(planLimits.ai_messages_per_mo) || "Pay per use";
    default:
      return null;
  }
}

// Renders a second line under the "Included" pill for services whose details
// carry actionable renewal / expiry information.
function ServiceDetailLine({ serviceId, svc }) {
  const details = svc?.details || {};
  if (!details || Object.keys(details).length === 0) return null;

  if (serviceId === "domain") {
    if (details.type === "subdomain" && details.domain) {
      return (
        <p className="text-xs text-accent mt-1 font-mono truncate">
          Your domain: {details.domain}
        </p>
      );
    }
    if (details.type !== "custom") return null;
    const status = domainStatusLabel(details.status);
    const expiry = formatExpiry(details.expires_at);
    const autoRenew = details.auto_renew === "true";
    const parts = [];
    if (status) parts.push(status);
    if (expiry) parts.push(`renews ${expiry}`);
    if (autoRenew) parts.push("auto-renew on");
    if (parts.length === 0) return null;
    return (
      <p className="text-xs text-accent mt-1 font-mono truncate">
        {parts.join(" · ")}
      </p>
    );
  }

  return null;
}

const SERVICE_META = [
  {
    id: "smtp",
    Icon: Mail,
    title: "Email / SMTP",
    desc: "Sends notifications, password resets, and alerts.",
  },
  {
    id: "domain",
    Icon: Globe,
    title: "Domain & DNS",
    desc: "Reach your apps at a domain name instead of an IP address.",
  },
  {
    id: "backup",
    Icon: Database,
    title: "Cloud Backup Storage",
    desc: "Where your backups are stored. Multiple destinations allowed.",
  },
  {
    id: "tunnel",
    Icon: Waypoints,
    title: "Tunnel",
    desc: "Access your server behind a firewall or CGNAT.",
  },
  {
    id: "ai",
    Icon: Sparkles,
    title: "AI Assistant",
    desc: "AI help managing your server.",
  },
  {
    id: "support",
    Icon: LifeBuoy,
    title: "Human Support",
    desc: "A real person to talk to if something goes wrong.",
    informational: true,
  },
];

const STATE_BADGES = {
  connected: { label: "Connected", class: "bg-accent text-primary" },
  byo: { label: "Bring Your Own", class: "bg-primary text-secondary border-2 border-accent/30" },
  disabled: { label: "Off", class: "bg-primary text-secondary/50 border-2 border-secondary/10" },
  unavailable: { label: "Not in Plan", class: "bg-primary text-secondary/30 border-2 border-secondary/10" },
};

export default function ExternalServicesCategory({
  connectStatus,
  connectInfo = null,
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
  const activePlanId = connectStatus?.plan?.id;
  const planLimits = connectInfo?.plan_limits?.[activePlanId] || null;
  const isConnected = !!connectStatus?.connected;
  // Modal content comes from connectStatus; until it has loaded, show the
  // modal shell with a skeleton body instead of a half-empty form.
  const modalLoading = loading || !connectStatus;

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

      {SERVICE_META.map(({ id, Icon, title, desc, informational }, i) => {
        const svc = services[id];
        const badge = svc ? STATE_BADGES[svc.state] : STATE_BADGES.disabled;
        const limitLabel = isConnected ? formatServiceLimit(id, planLimits) : null;

        return (
          <div
            key={id}
            role={informational ? undefined : "button"}
            tabIndex={informational ? undefined : 0}
            onClick={informational ? undefined : () => setOpenModal(id)}
            onKeyDown={
              informational
                ? undefined
                : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenModal(id); } }
            }
            className={cn(
              "rounded-large-element",
              !informational && "cursor-pointer focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            )}
          >
            <SettingsCard index={i} icon={Icon} title={title} padding={false}>
              <div className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-accent">{desc}</p>
                    {limitLabel && (
                      <div className="mt-2">
                        <span
                          className={cn(
                            "inline-flex items-center gap-2 text-xs px-2.5 py-1 rounded-pill font-mono",
                            "bg-primary text-secondary border-2 border-secondary/10"
                          )}
                          title={`Included on your ${connectStatus?.plan?.name || "plan"}`}
                        >
                          <span className="font-normal text-accent">Included:</span>
                          <span className={limitLabel === "Not in plan" ? "text-secondary/60" : "text-secondary"}>
                            {limitLabel}
                          </span>
                        </span>
                      </div>
                    )}
                    <ServiceDetailLine serviceId={id} svc={svc} />
                    {svc?.details && id !== "domain" && Object.keys(svc.details).length > 0 && (
                      <p className="text-xs text-accent/60 mt-1 font-mono truncate">
                        {Object.entries(svc.details).map(([k, v]) => `${k}: ${v}`).join(", ")}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={cn("text-xs px-2.5 py-1 rounded-pill font-medium", badge.class)}>
                      {badge.label}
                    </span>
                    {!informational && (
                      <svg
                        width="16" height="16" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" strokeWidth="2"
                        className="text-accent"
                        aria-hidden="true"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    )}
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
        loading={modalLoading}
        csrfToken={csrfToken}
      />
      <DomainServiceModal
        open={openModal === "domain"}
        onClose={closeModal}
        onSaved={onRefreshConnectStatus}
        service={services?.domain}
        connectStatus={connectStatus}
        loading={modalLoading}
        csrfToken={csrfToken}
      />
      <BackupServiceModal
        open={openModal === "backup"}
        onClose={closeModal}
        onSaved={onRefreshConnectStatus}
        service={services?.backup}
        repos={repos}
        connectStatus={connectStatus}
        loading={modalLoading}
        csrfToken={csrfToken}
      />
      <TunnelServiceModal
        open={openModal === "tunnel"}
        onClose={closeModal}
        onSaved={onRefreshConnectStatus}
        service={services?.tunnel}
        connectStatus={connectStatus}
        loading={modalLoading}
        csrfToken={csrfToken}
      />
      <AIServiceModal
        open={openModal === "ai"}
        onClose={closeModal}
        onSaved={onRefreshConnectStatus}
        service={services?.ai}
        connectStatus={connectStatus}
        aiSettings={aiSettings}
        loading={modalLoading}
        csrfToken={csrfToken}
      />

    </div>
  );
}
