import { cn } from "@/lib/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Server, Trash2, Wifi, WifiOff, Globe, RefreshCw, AlertTriangle, ExternalLink, ChevronDown, ChevronUp, Shield, Radio, Layers, PlugZap } from "lucide-react";
import PropTypes from "prop-types";
import ConfirmModal from "../../cards/ConfirmModal";
import SettingsCard from "../SettingsCard";
import SettingsRow from "../SettingsRow.jsx";
import RoutesCard from "../../network/RoutesCard";
import DebugCard from "../../network/DebugCard";
import RouteModal from "../RouteModal";
import ValueDisplay from "../../common/ValueDisplay";
import Dropdown from "../../common/Dropdown";
import Button from "../../ui/Button";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";
import {
  getCaddyStatus,
  listRoutes,
  getCaddyfile,
  getConnectivityStatus,
  getUPnPStatus,
  getDDNSStatus,
  ddnsForceUpdate,
  ddnsSetInterval,
  getTunnelStatus,
  getNetworkReport,
  getNetworkPlans,
} from "../../../lib/network-api";

// ─── Reachability card — the one big status the page leads with ────────────

function ReachabilityCard({ report, loading, onRetry }) {
  const status = useMemo(() => {
    if (loading) {
      return { icon: WifiOff, label: "Checking your network…", tone: "text-secondary/60", bg: "bg-accent/10 border-accent/20" };
    }
    if (!report) {
      return { icon: WifiOff, label: "We couldn't check your network right now.", tone: "text-warning", bg: "bg-warning/10 border-warning/20" };
    }
    const tunnel = report.connect?.active && report.connect?.tunnel_ok;
    const v4 = report.stacks?.v4?.inbound_open;
    const v6 = report.stacks?.v6?.inbound_open;
    if (tunnel) return { icon: Wifi, label: report.headline || "Your apps are reachable from the internet.", tone: "text-success", bg: "bg-success/10 border-success/20" };
    if (v4 && v6) return { icon: Wifi, label: report.headline || "Your apps are reachable on both network types.", tone: "text-success", bg: "bg-success/10 border-success/20" };
    if (v4 || v6) return { icon: Wifi, label: report.headline || "Your apps are reachable from the internet.", tone: "text-success", bg: "bg-success/10 border-success/20" };
    if (report.nat?.behind_double_nat) return { icon: AlertTriangle, label: report.headline, tone: "text-warning", bg: "bg-warning/10 border-warning/20" };
    return { icon: WifiOff, label: report.headline || "Only people on your home network can use your apps right now.", tone: "text-secondary/70", bg: "bg-primary/5 border-primary/10" };
  }, [report, loading]);

  const Icon = status.icon;

  // Coverage pills: which visitor networks can reach the apps.
  const coverage = useMemo(() => {
    if (loading || !report) return [];
    const tunnel = report.connect?.active && report.connect?.tunnel_ok;
    const v4 = report.stacks?.v4?.inbound_open;
    const v6 = report.stacks?.v6?.inbound_open;
    if (tunnel) return [{ label: "Everyone", ok: true }];
    const pills = [];
    if (v4) pills.push({ label: "All networks", ok: true });
    if (v6 && !v4) pills.push({ label: "Newer networks", ok: true });
    if (!v4 && !v6) pills.push({ label: "Home network only", ok: false });
    return pills;
  }, [report, loading]);

  return (
    <SettingsCard icon={Radio} title="Reachability" index={0}>
      <div className="px-5 py-4 space-y-4">
        <div className={cn("rounded-large-element border px-4 py-3 flex items-center gap-3", status.bg)}>
          <Icon className={cn("w-5 h-5 flex-shrink-0", status.tone)} />
          <span className={cn("font-mono text-sm font-semibold leading-snug", status.tone)}>{status.label}</span>
          {onRetry && report === null && !loading && (
            <Button type="button" variant="ghost" surface="secondary" size="sm" onClick={onRetry} className="ml-auto shrink-0">
              <RefreshCw size={14} /> Retry
            </Button>
          )}
        </div>

        {coverage.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {coverage.map((p) => (
              <span
                key={p.label}
                className={cn(
                  "text-xs px-3 py-1 rounded-pill border",
                  p.ok
                    ? "bg-success/10 border-success/20 text-success"
                    : "bg-primary/5 border-primary/10 text-secondary/60"
                )}
              >
                {p.label}
              </span>
            ))}
          </div>
        )}

        {report && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {report.stacks?.v4?.public_addr && (
              <ValueDisplay label="Public Address" value={report.stacks.v4.public_addr} />
            )}
            {report.stacks?.v6?.public_addr && (
              <ValueDisplay label="IPv6 Address" value={report.stacks.v6.public_addr} />
            )}
            {report.nat?.type && report.nat.type !== "unknown" && (
              <ValueDisplay label="Network Type" value={report.nat.type} mono={false} />
            )}
            {report.upnp?.discovered && (
              <ValueDisplay
                label="Router"
                value={[report.upnp.router_make, report.upnp.router_model].filter(Boolean).join(" ") || "Router"}
                mono={false}
              />
            )}
            {report.domain?.name && <ValueDisplay label="Domain" value={report.domain.name} />}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}
ReachabilityCard.propTypes = {
  report: PropTypes.object,
  loading: PropTypes.bool,
  onRetry: PropTypes.func,
};

// ─── Per-app plan cards — what each app needs and how it's reached ─────────

function AppPlanCard({ plan, index }) {
  const needLabel = useMemo(() => {
    const parts = [];
    if (plan.ports?.length) {
      parts.push(`Needs port${plan.ports.length > 1 ? "s" : ""} ${plan.ports.join(", ")}`);
    } else {
      parts.push("Web access");
    }
    return parts.join(" · ");
  }, [plan]);

  const stateCfg = {
    direct_v4: { label: "Reachable directly", tone: "text-success", bg: "bg-success/10 border-success/20" },
    direct_v6: { label: "Reachable directly", tone: "text-success", bg: "bg-success/10 border-success/20" },
    upnp: { label: "Ports opened on your router", tone: "text-success", bg: "bg-success/10 border-success/20" },
    guide_upnp: { label: "Router setting needs turning on", tone: "text-warning", bg: "bg-warning/10 border-warning/20" },
    cloudflared: { label: "Reachable via protected connection", tone: "text-success", bg: "bg-success/10 border-success/20" },
    frp: { label: "Reachable via dedicated address", tone: "text-success", bg: "bg-success/10 border-success/20" },
    lan_only: { label: "Home network only", tone: "text-secondary/70", bg: "bg-primary/5 border-primary/10" },
  };
  const cfg = stateCfg[plan.path] || stateCfg.lan_only;

  return (
    <SettingsCard icon={PlugZap} title={plan.app_name} index={index}>
      <div className="px-5 py-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="text-xs text-secondary/60">{needLabel}</span>
          <span className={cn("text-xs px-3 py-1 rounded-pill border font-mono", cfg.bg, cfg.tone)}>
            {cfg.label}
          </span>
        </div>
        <p className="text-sm text-primary/70 leading-relaxed">{plan.message}</p>
        {plan.addon_needed && (
          <p className="text-xs text-warning leading-relaxed">
            A dedicated address would make this reachable from the internet. Check Connect plans to add one.
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
AppPlanCard.propTypes = { plan: PropTypes.object, index: PropTypes.number };

// ─── Advanced section (collapsed by default) ────────────────────────────────

function AdvancedSection({ children, count }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "w-full flex items-center justify-between px-4 py-3 rounded-pill",
          "bg-primary text-secondary border-2 border-secondary/10",
          "hover:border-accent hover:text-accent motion-safe:transition-colors"
        )}
      >
        <span className="font-mono text-sm font-semibold flex items-center gap-2">
          <Layers size={16} />
          Advanced
          {typeof count === "number" && count > 0 && (
            <span className="text-xs text-secondary/50">({count})</span>
          )}
        </span>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open && <div className="space-y-6">{children}</div>}
    </div>
  );
}
AdvancedSection.propTypes = { children: PropTypes.node, count: PropTypes.number };

// ─── Legacy detailed cards (kept for advanced users) ────────────────────────

function RemoteAccessStatusCard({ connectivity, index }) {
  if (!connectivity) return null;

  const statusConfig = {
    active: { icon: Wifi, label: "Remote Access Active", className: "text-success", bg: "bg-success/10 border-success/20" },
    degraded: { icon: Wifi, label: "Limited Remote Access", className: "text-warning", bg: "bg-warning/10 border-warning/20" },
    local_only: { icon: WifiOff, label: "Local Access Only", className: "text-accent", bg: "bg-accent/10 border-accent/20" },
    blocked: { icon: AlertTriangle, label: "Remote Access Blocked", className: "text-error", bg: "bg-error/10 border-error/20" },
    unknown: { icon: WifiOff, label: "Checking...", className: "text-secondary/50", bg: "bg-primary/5 border-primary/10" },
  };

  const cfg = statusConfig[connectivity.remote_access] || statusConfig.unknown;
  const Icon = cfg.icon;

  const natLabel = {
    open: "Direct (no NAT)",
    full_cone: "Full Cone NAT",
    restricted: "Restricted NAT",
    port_restricted: "Port Restricted NAT",
    symmetric: "Symmetric NAT",
    cgnat: "Carrier-Grade NAT",
    blocked: "UDP Blocked",
  };

  return (
    <SettingsCard icon={Radio} title="Remote Access" index={index}>
      <div className="px-5 py-4 space-y-4">
        <div className={cn("rounded-large-element border px-4 py-3 flex items-center gap-3", cfg.bg)}>
          <Icon className={cn("w-5 h-5", cfg.className)} />
          <span className={cn("font-mono text-sm font-semibold", cfg.className)}>{cfg.label}</span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {connectivity.public_ip && (
            <ValueDisplay label="Public IP" value={connectivity.public_ip} />
          )}
          {connectivity.nat_type && connectivity.nat_type !== "unknown" && (
            <ValueDisplay label="Network Type" value={natLabel[connectivity.nat_type] || connectivity.nat_type} mono={false} />
          )}
          {connectivity.domain?.configured && (
            <ValueDisplay label="Domain" value={connectivity.domain.domain} />
          )}
        </div>

        {connectivity.suggestions?.length > 0 && (
          <div className="space-y-1.5">
            {connectivity.suggestions.map((s, i) => (
              <p key={i} className="text-xs text-primary/60 leading-relaxed">{s}</p>
            ))}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}
RemoteAccessStatusCard.propTypes = { connectivity: PropTypes.object, index: PropTypes.number };

function IPMonitorCard({ ddns, index }) {
  const { addToast } = useToast();
  const [updating, setUpdating] = useState(false);

  const handleForceUpdate = useCallback(async () => {
    setUpdating(true);
    try {
      await ddnsForceUpdate();
      addToast({ type: "success", message: "IP check complete" });
    } catch {
      addToast({ type: "error", message: "IP check failed" });
    } finally {
      setUpdating(false);
    }
  }, [addToast]);

  const handleSetInterval = useCallback(async (value) => {
    const minutes = parseInt(value, 10);
    if (isNaN(minutes) || minutes < 1 || minutes > 60) return;
    try {
      await ddnsSetInterval(minutes);
      addToast({ type: "success", message: `Check interval set to ${minutes} min` });
    } catch {
      addToast({ type: "error", message: "Failed to set interval" });
    }
  }, [addToast]);

  if (!ddns) return null;

  return (
    <SettingsCard icon={Globe} title="IP Monitor" index={index}>
      <div className="px-5 py-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <ValueDisplay
            label="Status"
            value={ddns.running
              ? <span className="text-success">Running</span>
              : <span className="text-error">Stopped</span>
            }
            mono={false}
          />
          {ddns.current_ip && <ValueDisplay label="Current IP" value={ddns.current_ip} />}
          {ddns.last_update && (
            <ValueDisplay label="Last Check" value={new Date(ddns.last_update).toLocaleString()} mono={false} />
          )}
          {ddns.last_error && (
            <ValueDisplay label="Last Error" value={ddns.last_error} mono={false} />
          )}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Dropdown
            value={String(ddns.interval_minutes || 5)}
            onChange={handleSetInterval}
            options={[
              { value: "1", label: "1 min" },
              { value: "2", label: "2 min" },
              { value: "5", label: "5 min" },
              { value: "10", label: "10 min" },
              { value: "15", label: "15 min" },
              { value: "30", label: "30 min" },
              { value: "60", label: "60 min" },
            ]}
            width={80}
            surface="primary"
          />
          <span className="text-xs text-primary/50">Check interval</span>

          <Button variant="accent" onClick={handleForceUpdate} disabled={updating} className="ml-auto">
            <RefreshCw size={14} className={updating ? "animate-spin" : ""} />
            Check Now
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}
IPMonitorCard.propTypes = { ddns: PropTypes.object, index: PropTypes.number };

function UPnPCard({ upnp, index }) {
  if (!upnp) return null;

  return (
    <SettingsCard icon={Shield} title="UPnP" index={index}>
      <div className="px-5 py-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <ValueDisplay
            label="Status"
            value={upnp.available
              ? <span className="text-success">Available</span>
              : <span className="text-warning">Unavailable</span>
            }
            mono={false}
          />
          <ValueDisplay
            label="Enabled"
            value={upnp.enabled
              ? <span className="text-success">Yes</span>
              : <span className="text-primary/50">No</span>
            }
            mono={false}
          />
          {upnp.external_ip && <ValueDisplay label="External IP" value={upnp.external_ip} />}
        </div>

        {upnp.available && !upnp.enabled && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-pill bg-warning/10 border border-warning/20">
            <AlertTriangle size={14} className="text-warning mt-0.5 flex-shrink-0" />
            <p className="text-xs text-warning leading-relaxed">
              UPnP is available on your router but not enabled. Enable it for automatic port forwarding.
            </p>
          </div>
        )}

        {!upnp.available && (
          <p className="text-xs text-primary/50 leading-relaxed">
            Your router does not support UPnP, or it is disabled. You can set up port forwarding manually instead.
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
UPnPCard.propTypes = { upnp: PropTypes.object, index: PropTypes.number };

function PortForwardingGuideCard({ connectivity, index }) {
  const [showSteps, setShowSteps] = useState(false);
  const localIP = connectivity?.local_ip || "";
  const needsGuide = connectivity?.nat_type === "full_cone" ||
    connectivity?.nat_type === "restricted" ||
    connectivity?.nat_type === "port_restricted";

  if (!needsGuide) return null;

  return (
    <SettingsCard icon={ExternalLink} title="Port Forwarding" index={index}>
      <div className="px-5 py-4 space-y-3">
        <p className="text-sm text-primary/70 leading-relaxed">
          Your router needs to be told to send incoming traffic to this device. This is a one-time setup in your router settings.
        </p>

        <Button
          type="button"
          variant="ghost"
          surface="secondary"
          size="sm"
          onClick={() => setShowSteps(!showSteps)}
          className="font-mono"
        >
          {showSteps ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          {showSteps ? "Hide steps" : "Show steps"}
        </Button>

        {showSteps && (
          <ol className="list-decimal list-inside space-y-2 text-xs text-primary/70 leading-relaxed">
            <li>Open your router settings (usually <span className="font-mono text-primary">http://192.168.1.1</span> or <span className="font-mono text-primary">http://10.0.0.1</span>)</li>
            <li>Find the <strong>Port Forwarding</strong> or <strong>NAT</strong> section</li>
            <li>Add a rule: forward <span className="font-mono text-primary">TCP port 80</span> to <span className="font-mono text-primary">{localIP || "this device"}</span></li>
            <li>Add a rule: forward <span className="font-mono text-primary">TCP port 443</span> to <span className="font-mono text-primary">{localIP || "this device"}</span></li>
            <li>Save and apply</li>
          </ol>
        )}

        <div className="rounded-large-element bg-secondary/5 border border-primary/10 px-3 py-2">
          <p className="text-xs text-primary/50">
            <strong className="font-mono text-primary/70">Your device IP:</strong> {localIP || "Detecting..."}
          </p>
        </div>
      </div>
    </SettingsCard>
  );
}
PortForwardingGuideCard.propTypes = { connectivity: PropTypes.object, index: PropTypes.number };

function CGNATGuidanceCard({ connectivity, index }) {
  const isCGNAT = connectivity?.nat_type === "cgnat" || connectivity?.nat_type === "symmetric" || connectivity?.nat_type === "blocked";
  if (!isCGNAT) return null;

  return (
    <SettingsCard icon={AlertTriangle} title="Network Limited" index={index}>
      <div className="px-5 py-4 space-y-3">
        <div className="rounded-large-element bg-error/10 border border-error/20 px-4 py-3">
          <p className="text-sm text-error leading-relaxed">
            {connectivity.nat_type === "cgnat"
              ? "Your internet provider shares your address with other customers, so regular port forwarding won't work."
              : connectivity.nat_type === "symmetric"
              ? "Your router uses a strict network type that prevents port forwarding from working."
              : "Your network blocks incoming connections entirely."
            }
          </p>
        </div>

        <p className="text-sm text-primary/70 leading-relaxed">
          To make your apps reachable from outside your home, you need a tunnel service. Options:
        </p>

        <div className="space-y-2">
          <div className="rounded-large-element bg-secondary/5 border border-primary/10 px-4 py-3">
            <p className="text-sm font-mono text-primary mb-1">Cloudflare Tunnel</p>
            <p className="text-xs text-primary/60 leading-relaxed">
              Routes traffic through Cloudflare's network. Requires a domain managed by Cloudflare. Free for personal use.
            </p>
            <a
              href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80 mt-2"
            >
              Learn more <ExternalLink size={12} />
            </a>
          </div>

          <div className="rounded-large-element bg-secondary/5 border border-primary/10 px-4 py-3">
            <p className="text-sm font-mono text-primary mb-1">WireGuard VPS</p>
            <p className="text-xs text-primary/60 leading-relaxed">
              Rent a small server (~$5/month) and create a private tunnel. Full control, no third-party dependency.
            </p>
            <a
              href="https://www.wireguard.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80 mt-2"
            >
              Learn more <ExternalLink size={12} />
            </a>
          </div>

          <div className="rounded-large-element bg-secondary/5 border border-primary/10 px-4 py-3">
            <p className="text-sm font-mono text-primary mb-1">Contact Your ISP</p>
            <p className="text-xs text-primary/60 leading-relaxed">
              Ask your provider for a public IP address. Some ISPs will provide one for free or a small fee.
            </p>
          </div>
        </div>
      </div>
    </SettingsCard>
  );
}
CGNATGuidanceCard.propTypes = { connectivity: PropTypes.object, index: PropTypes.number };

// ─── Main page ──────────────────────────────────────────────────────────────

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
  const [connectivity, setConnectivity] = useState(null);
  const [upnpStatus, setUpnpStatus] = useState(null);
  const [ddnsStatus, setDdnsStatus] = useState(null);
  const [tunnelStatus, setTunnelStatus] = useState(null);
  const [report, setReport] = useState(null);
  const [plans, setPlans] = useState([]);
  const [reportLoading, setReportLoading] = useState(true);

  const defaultDomain = useMemo(() => settings?.proxy?.default_domain || "", [settings]);

  const loadReport = useCallback(async () => {
    setReportLoading(true);
    try {
      const [rep, pl] = await Promise.all([
        getNetworkReport().catch(() => null),
        getNetworkPlans().catch(() => []),
      ]);
      setReport(rep);
      setPlans(Array.isArray(pl?.plans) ? pl.plans : []);
    } finally {
      setReportLoading(false);
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [routesData, statusData, appsData, caddyData, connectivityData, upnpData, ddnsData, tunnelData] = await Promise.all([
        listRoutes(),
        getCaddyStatus(),
        request("/apps").then((r) => r.json()).catch(() => []),
        getCaddyfile().catch(() => ""),
        getConnectivityStatus().catch(() => null),
        getUPnPStatus().catch(() => null),
        getDDNSStatus().catch(() => null),
        getTunnelStatus().catch(() => ({ available: false, enabled: false })),
      ]);
      setRoutes(Array.isArray(routesData) ? routesData : []);
      setCaddyStatus(statusData);
      setApps(Array.isArray(appsData?.apps) ? appsData.apps : []);
      setCaddyfileContent(caddyData || "");
      setConnectivity(connectivityData);
      setUpnpStatus(upnpData);
      setDdnsStatus(ddnsData);
      setTunnelStatus(tunnelData);
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
    loadReport();
  }, [loadData, loadReport]);

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

  let cardIndex = 0;

  return (
    <div className="space-y-6" data-slot="network-category">
      <ReachabilityCard report={report} loading={reportLoading} onRetry={loadReport} />

      {plans.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-mono text-sm font-semibold text-secondary flex items-center gap-2 px-1">
            <PlugZap size={15} />
            Your Apps
          </h3>
          {plans.map((plan) => <AppPlanCard key={plan.app_id} plan={plan} index={cardIndex++} />)}
        </div>
      )}

      <AdvancedSection count={6}>
        <RemoteAccessStatusCard connectivity={connectivity} index={cardIndex++} />

        <SettingsCard icon={Globe} title="Domain & DNS" padding={false} index={cardIndex++}>
          <SettingsRow
            label="Configure your domain"
            description={defaultDomain ? `Current: ${defaultDomain}` : "No domain configured"}
          >
            <a
              href="#external_services"
              className="text-xs px-3 py-1.5 rounded-pill bg-primary text-secondary border-2 border-secondary/10 hover:bg-accent hover:text-primary hover:border-accent motion-safe:transition-colors"
            >
              External Services →
            </a>
          </SettingsRow>
        </SettingsCard>

        <SettingsCard icon={Shield} title="Tunnel" padding={false} index={cardIndex++}>
          <SettingsRow
            label="Tunnel service"
            description={tunnelStatus?.enabled ? "Connected" : "Not configured"}
          >
            <a
              href="#external_services"
              className="text-xs px-3 py-1.5 rounded-pill bg-primary text-secondary border-2 border-secondary/10 hover:bg-accent hover:text-primary hover:border-accent motion-safe:transition-colors"
            >
              External Services →
            </a>
          </SettingsRow>
        </SettingsCard>

        <IPMonitorCard ddns={ddnsStatus} index={cardIndex++} />

        <UPnPCard upnp={upnpStatus} index={cardIndex++} />

        <PortForwardingGuideCard connectivity={connectivity} index={cardIndex++} />

        <CGNATGuidanceCard connectivity={connectivity} index={cardIndex++} />

        {caddyStatus && (
          <SettingsCard icon={Server} title="Proxy Status" index={cardIndex++}>
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
                label="Configuration"
                value={
                  caddyStatus.config_valid
                    ? <span className="text-success">Valid</span>
                    : <span className="text-warning">Invalid</span>
                }
              />
              <ValueDisplay label="Web Addresses" value={String(caddyStatus.routes || routes.length)} />
              <ValueDisplay label="Domains" value={String(caddyStatus.domains?.length || 0)} />
            </div>
          </SettingsCard>
        )}

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
      </AdvancedSection>

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
          <div className="mt-3 bg-warning/10 border border-warning/30 rounded-large-element p-3">
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