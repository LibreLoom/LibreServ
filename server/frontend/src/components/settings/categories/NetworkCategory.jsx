import { cn } from "@/lib/utils";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Server, Trash2, Wifi, WifiOff, Globe, RefreshCw, AlertTriangle, ExternalLink, ChevronDown, Shield, Radio, Layers, PlugZap } from "lucide-react";
import PropTypes from "prop-types";
import ConfirmModal from "../../cards/ConfirmModal";
import SettingsCard from "../SettingsCard";
import SettingsRow from "../SettingsRow.jsx";
import RoutesCard from "../../network/RoutesCard";
import DebugCard from "../../network/DebugCard";
import RouteModal from "../RouteModal";
import ValueDisplay from "../../common/ValueDisplay";
import CollapsibleSection from "../../common/CollapsibleSection";
import Button from "../../ui/Button";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";
import {
  getCaddyStatus,
  listRoutes,
  getCaddyfile,
  getConnectivityStatus,
  getUPnPStatus,
  getTunnelStatus,
  getNetworkReport,
  getNetworkPlans,
} from "../../../lib/network-api";
import { ICON_SIZE } from "@/lib/ui-tokens";

// ─── Reachability — the one big status the page leads with ──────────────────

function ReachabilityCard({ report, loading, onRetry, connectivity }) {
  const tunnel = report?.connect?.active && report?.connect?.tunnel_ok;
  const v4 = report?.stacks?.v4?.inbound_open;
  const v6 = report?.stacks?.v6?.inbound_open;
  const reachable = Boolean(tunnel || v4 || v6);

  const status = useMemo(() => {
    if (!report) {
      return { icon: WifiOff, label: "We couldn't check your network right now.", tone: "text-warning", bg: "bg-warning/10 border-warning/20" };
    }
    if (tunnel) return { icon: Wifi, label: report.headline || "Your apps are reachable from the internet.", tone: "text-success", bg: "bg-success/10 border-success/20" };
    if (v4 && v6) return { icon: Wifi, label: report.headline || "Your apps are reachable on both network types.", tone: "text-success", bg: "bg-success/10 border-success/20" };
    if (v4 || v6) return { icon: Wifi, label: report.headline || "Your apps are reachable from the internet.", tone: "text-success", bg: "bg-success/10 border-success/20" };
    if (report.nat?.behind_double_nat) return { icon: AlertTriangle, label: report.headline, tone: "text-warning", bg: "bg-warning/10 border-warning/20" };
    return { icon: WifiOff, label: report.headline || "Only people on your home network can use your apps right now.", tone: "text-primary", bg: "bg-primary/5 border-primary/10" };
  }, [report, tunnel, v4, v6]);

  const Icon = status.icon;

  // Coverage pills: which visitor networks can reach the apps.
  const coverage = useMemo(() => {
    if (!report) return [];
    if (tunnel) return [{ label: "Everyone", ok: true }];
    const pills = [];
    if (v4) pills.push({ label: "All networks", ok: true });
    if (v6 && !v4) pills.push({ label: "Newer networks", ok: true });
    if (!v4 && !v6) pills.push({ label: "Home network only", ok: false });
    return pills;
  }, [report, tunnel, v4, v6]);

  // Which fix applies when nothing is reachable, in priority order. Port
  // forwarding can't help behind double NAT (the address is shared), and a
  // discovered-but-disabled router UPnP is a one-switch fix that beats manual
  // rules. "generic" is the honest fallback when detection produced no usable
  // NAT type.
  const doubleNAT =
    Boolean(report?.nat?.behind_double_nat) ||
    ["cgnat", "symmetric", "blocked"].includes(connectivity?.nat_type);
  const upnpOff = report?.upnp?.discovered && !report?.upnp?.enabled;
  const needsPortForwarding = ["full_cone", "restricted", "port_restricted"].includes(connectivity?.nat_type);
  const guide = !reachable
    ? doubleNAT
      ? "cgnat"
      : upnpOff
        ? "upnp"
        : needsPortForwarding
          ? "ports"
          : report
            ? "generic"
            : null
    : null;

  const localIP = connectivity?.local_ip || "";
  const routerName = [report?.upnp?.router_make, report?.upnp?.router_model].filter(Boolean).join(" ");

  // Leave the section empty while the diagnosis runs — a "Checking your
  // network…" label swapping to the result reads as a flash between loading
  // and loaded states (same pattern as CriticalIssues).
  if (loading && !report) {
    return <SettingsCard icon={Radio} title="Reachability" index={0} />;
  }

  return (
    <SettingsCard icon={Radio} title="Reachability" index={0}>
      <div className="px-5 py-4 space-y-4 animate-in fade-in duration-150">
        <div className={cn("rounded-large-element border px-4 py-3 flex items-center gap-3", status.bg)}>
          <Icon className={cn("w-5 h-5 flex-shrink-0", status.tone)} />
          <span className={cn("font-mono text-sm font-semibold leading-snug", status.tone)}>{status.label}</span>
          {onRetry && report === null && !loading && (
            <Button type="button" variant="ghost" surface="secondary" size="sm" onClick={onRetry} className="ml-auto shrink-0">
              <RefreshCw size={ICON_SIZE.sm} /> Retry
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
                    : "bg-primary/5 border-primary/10 text-primary"
                )}
              >
                {p.label}
              </span>
            ))}
          </div>
        )}

        {guide === "cgnat" && (
          <div className="rounded-large-element bg-primary/5 border border-primary/10 px-4 py-3 space-y-3">
            <div className="rounded-large-element bg-error/10 border border-error/20 px-4 py-3">
              <p className="text-sm text-error leading-relaxed">
                {connectivity?.nat_type === "symmetric"
                  ? "Your router uses a strict network type that prevents port forwarding from working."
                  : connectivity?.nat_type === "blocked"
                    ? "Your network blocks incoming connections entirely."
                    : "Your internet provider shares your address with other customers, so regular port forwarding won't work."
                }
              </p>
            </div>

            <p className="text-sm text-primary leading-relaxed">
              Your apps need a protected connection out to the internet. The simple fix: LibreServ Connect gives this device an address on the internet — no router changes needed.
            </p>
            <p className="text-xs text-primary leading-relaxed">
              In External Services: activate <strong>Connect</strong> at the top, then open the <strong>Tunnel</strong> card and turn it on.
            </p>
            <div>
              <Button asChild variant="primary" size="sm" surface="secondary">
                <a href="#external_services">Open External Services →</a>
              </Button>
            </div>

            <CollapsibleSection title="Other ways to fix this" size="sm" pill>
              <div className="space-y-2">
                <div className="rounded-large-element bg-primary/5 border border-primary/10 px-4 py-3">
                  <p className="text-sm font-mono text-primary mb-1">Cloudflare Tunnel</p>
                  <p className="text-xs text-primary leading-relaxed">
                    Routes traffic through Cloudflare's network. Requires a domain managed by Cloudflare. Free for personal use.
                  </p>
                  <a
                    href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-accent hover:underline mt-2"
                  >
                    Learn more <ExternalLink size={ICON_SIZE.xs} />
                  </a>
                </div>

                <div className="rounded-large-element bg-primary/5 border border-primary/10 px-4 py-3">
                  <p className="text-sm font-mono text-primary mb-1">WireGuard VPS</p>
                  <p className="text-xs text-primary leading-relaxed">
                    Rent a small server (~$5/month) and create a private tunnel. Full control, no third-party dependency.
                  </p>
                  <a
                    href="https://www.wireguard.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-accent hover:underline mt-2"
                  >
                    Learn more <ExternalLink size={ICON_SIZE.xs} />
                  </a>
                </div>

                <div className="rounded-large-element bg-primary/5 border border-primary/10 px-4 py-3">
                  <p className="text-sm font-mono text-primary mb-1">Ask your internet provider</p>
                  <p className="text-xs text-primary leading-relaxed">
                    Ask for a public IP address. Some providers will give you one for free or a small fee.
                  </p>
                </div>
              </div>
            </CollapsibleSection>
          </div>
        )}

        {guide === "upnp" && (
          <div className="rounded-large-element bg-primary/5 border border-primary/10 px-4 py-3 space-y-3">
            <p className="font-mono text-sm font-semibold text-primary">Here's what to do</p>
            <p className="text-sm text-primary leading-relaxed">
              Your {routerName ? `${routerName} ` : ""}router already has the setting that opens your apps to the internet automatically — it's just turned off. Turning it on is the easiest fix.
            </p>
            <ol className="list-decimal list-inside space-y-2 text-xs text-primary leading-relaxed">
              <li>Open your router settings (usually <span className="font-mono text-primary">http://192.168.1.1</span> or <span className="font-mono text-primary">http://10.0.0.1</span>)</li>
              <li>Find the setting called <strong>UPnP</strong> (often under Advanced or Network settings)</li>
              <li>Turn it on</li>
              <li>Save and apply</li>
            </ol>
            <div className="border-t border-primary/10 pt-2">
              <p className="text-xs text-primary">
                Prefer not to use UPnP? Set up port forwarding manually instead: forward <span className="font-mono text-primary">TCP ports 80 and 443</span> to <span className="font-mono text-primary">{localIP || "this device"}</span>.
              </p>
            </div>
          </div>
        )}

        {guide === "ports" && (
          <div className="rounded-large-element bg-primary/5 border border-primary/10 px-4 py-3 space-y-3">
            <p className="font-mono text-sm font-semibold text-primary">Here's what to do</p>
            <p className="text-sm text-primary leading-relaxed">
              Your router{routerName ? ` (${routerName})` : ""} blocks outside traffic, so only people on your
              home network can use your apps right now. To let other people in, tell your router to send web
              traffic to this device (that's ports 80 and 443). This is a one-time setup.
            </p>
            <ol className="list-decimal list-inside space-y-2 text-xs text-primary leading-relaxed">
              <li>Open your router settings (usually <span className="font-mono text-primary">http://192.168.1.1</span> or <span className="font-mono text-primary">http://10.0.0.1</span>)</li>
              <li>Find the section called <strong>Port Forwarding</strong> (sometimes listed as <strong>NAT</strong> or <strong>Port Mapping</strong>)</li>
              <li>Add a rule: forward <span className="font-mono text-primary">TCP port 80</span> to <span className="font-mono text-primary">{localIP || "this device"}</span></li>
              <li>Add a rule: forward <span className="font-mono text-primary">TCP port 443</span> to <span className="font-mono text-primary">{localIP || "this device"}</span></li>
              <li>Save and apply</li>
            </ol>
            <div className="border-t border-primary/10 pt-2">
              <p className="text-xs text-primary">
                <strong className="font-mono text-primary">Your device IP:</strong> {localIP || "Detecting..."}
              </p>
            </div>
            <div className="border-t border-primary/10 pt-3 space-y-2">
              <p className="text-xs text-primary leading-relaxed">
                Prefer to skip the router setup? Open the <strong>Tunnel</strong> card in External Services and turn it on — no router changes needed. You'll need either a LibreServ Connect account or a Cloudflare Tunnel token.
              </p>
              <Button asChild variant="outline" size="sm" surface="secondary">
                <a href="#external_services-tunnel">Open Tunnel setup →</a>
              </Button>
            </div>
          </div>
        )}

        {guide === "generic" && (
          <div className="rounded-large-element bg-primary/5 border border-primary/10 px-4 py-3 space-y-3">
            <p className="font-mono text-sm font-semibold text-primary">Here's what to do</p>
            <p className="text-sm text-primary leading-relaxed">
              We couldn't determine exactly how your network is set up. Either of these will let other people reach your apps:
            </p>
            <ol className="list-decimal list-inside space-y-2 text-xs text-primary leading-relaxed">
              <li><strong>Port forwarding</strong> — tell your router to send web traffic (ports 80 and 443) to this device. In your router settings, look for <strong>Port Forwarding</strong> (sometimes called <strong>NAT</strong>).</li>
              <li><strong>A protected connection</strong> — open the <a href="#external_services-tunnel" className="text-accent underline">Tunnel</a> card in External Services and turn it on. No router changes needed.</li>
            </ol>
          </div>
        )}

        {report && (
          <div className="space-y-2">
            <p className="font-mono text-xs font-semibold text-primary">About your network</p>
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
  connectivity: PropTypes.object,
};

// ─── Your apps — one card, one row per app ──────────────────────────────────

const PLAN_STATE = {
  direct_v4: { label: "Reachable directly", tone: "text-success", bg: "bg-success/10 border-success/20" },
  direct_v6: { label: "Reachable directly", tone: "text-success", bg: "bg-success/10 border-success/20" },
  upnp: { label: "Ports opened on your router", tone: "text-success", bg: "bg-success/10 border-success/20" },
  guide_upnp: { label: "Router setting needs turning on", tone: "text-warning", bg: "bg-warning/10 border-warning/20" },
  cloudflared: { label: "Reachable via protected connection", tone: "text-success", bg: "bg-success/10 border-success/20" },
  frp: { label: "Reachable via dedicated address", tone: "text-success", bg: "bg-success/10 border-success/20" },
  lan_only: { label: "Home network only", tone: "text-primary", bg: "bg-primary/5 border-primary/10" },
};

function AppPlanRow({ plan }) {
  const needLabel = useMemo(() => {
    if (plan.ports?.length) {
      const labels = plan.ports.map((p) => (p.protocol ? `${p.protocol} ${p.port}` : String(p.port)));
      return `Needs port${labels.length > 1 ? "s" : ""} ${labels.join(", ")}`;
    }
    return "Web access";
  }, [plan]);

  const cfg = PLAN_STATE[plan.path] || PLAN_STATE.lan_only;

  return (
    <div className="px-5 py-4 space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold text-primary truncate">{plan.app_name}</p>
          <p className="text-xs text-primary mt-0.5">{needLabel}</p>
        </div>
        <span className={cn("text-xs px-3 py-1 rounded-pill border font-mono shrink-0", cfg.bg, cfg.tone)}>
          {cfg.label}
        </span>
      </div>
      {plan.message && (
        <p className="text-sm text-primary leading-relaxed">{plan.message}</p>
      )}
      {plan.addon_needed && (
        <p className="text-xs text-warning leading-relaxed">
          A dedicated address would make this reachable from the internet. Check Connect plans to add one.
        </p>
      )}
    </div>
  );
}
AppPlanRow.propTypes = { plan: PropTypes.object };

function AppsCard({ plans, index }) {
  return (
    <SettingsCard icon={PlugZap} title="Your Apps" padding={false} index={index}>
      <div className="divide-y divide-primary/10">
        {plans.map((plan) => <AppPlanRow key={plan.app_id} plan={plan} />)}
      </div>
    </SettingsCard>
  );
}
AppsCard.propTypes = { plans: PropTypes.array.isRequired, index: PropTypes.number };

// ─── Advanced section (collapsed by default) ────────────────────────────────

function AdvancedSection({ children }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={contentId}
        className={cn(
          "w-full flex items-center justify-between px-4 py-3 rounded-pill",
          "bg-primary text-secondary border-2 border-secondary/10",
          "hover:border-accent hover:text-accent motion-safe:transition-colors"
        )}
      >
        <span className="font-mono text-sm font-semibold flex items-center gap-2">
          <Layers size={ICON_SIZE.md} />
          Advanced
        </span>
        <ChevronDown
          size={ICON_SIZE.md}
          className={cn("motion-safe:transition-transform duration-200", open ? "rotate-180" : "rotate-0")}
          aria-hidden="true"
        />
      </button>
      {/* Always mounted so opening never replays the cards' entrance
          animations; visibility is toggled with a grid-rows collapse. */}
      <div
        id={contentId}
        inert={!open}
        className={cn(
          "grid motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-[var(--motion-easing-emphasized)]",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
AdvancedSection.propTypes = { children: PropTypes.node };

function ExternalServicesLinkRow({ label, description }) {
  return (
    <SettingsRow label={label} description={description}>
      <Button asChild variant="outline" size="sm" surface="secondary">
        <a href="#external_services">External Services →</a>
      </Button>
    </SettingsRow>
  );
}
ExternalServicesLinkRow.propTypes = { label: PropTypes.string, description: PropTypes.string };

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
              : <span className="text-primary">No</span>
            }
            mono={false}
          />
          {upnp.external_ip && <ValueDisplay label="External IP" value={upnp.external_ip} />}
        </div>

        {upnp.available && !upnp.enabled && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-large-element bg-warning/10 border border-warning/20">
            <AlertTriangle size={ICON_SIZE.sm} className="text-warning mt-0.5 flex-shrink-0" />
            <p className="text-xs text-warning leading-relaxed">
              UPnP is available on your router but not enabled. Enable it for automatic port forwarding.
            </p>
          </div>
        )}

        {!upnp.available && (
          <p className="text-xs text-primary leading-relaxed">
            Your router does not support UPnP, or it is disabled. You can set up port forwarding manually instead.
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
UPnPCard.propTypes = { upnp: PropTypes.object, index: PropTypes.number };

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
      const [routesData, statusData, appsData, caddyData, connectivityData, upnpData, tunnelData] = await Promise.all([
        listRoutes(),
        getCaddyStatus(),
        request("/apps").then((r) => r.json()).catch(() => []),
        getCaddyfile().catch(() => ""),
        getConnectivityStatus().catch(() => null),
        getUPnPStatus().catch(() => null),
        getTunnelStatus().catch(() => ({ available: false, enabled: false })),
      ]);
      setRoutes(Array.isArray(routesData) ? routesData : []);
      setCaddyStatus(statusData);
      setApps(Array.isArray(appsData?.apps) ? appsData.apps : []);
      setCaddyfileContent(caddyData || "");
      setConnectivity(connectivityData);
      setUpnpStatus(upnpData);
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
      <ReachabilityCard report={report} loading={reportLoading} onRetry={loadReport} connectivity={connectivity} />
      {plans.length > 0 && <AppsCard plans={plans} index={cardIndex++} />}

      <AdvancedSection>
        <SettingsCard icon={Globe} title="Domain & DNS" padding={false} index={cardIndex++}>
          <ExternalServicesLinkRow
            label="Configure your domain"
            description={defaultDomain ? `Current: ${defaultDomain}` : "No domain configured"}
          />
        </SettingsCard>

        <SettingsCard icon={Shield} title="Tunnel" padding={false} index={cardIndex++}>
          <ExternalServicesLinkRow
            label="Tunnel service"
            description={tunnelStatus?.enabled ? "Connected" : "Not configured"}
          />
        </SettingsCard>

        <UPnPCard upnp={upnpStatus} index={cardIndex++} />

        {caddyStatus && (
          <SettingsCard icon={Server} title="Web Server" index={cardIndex++}>
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