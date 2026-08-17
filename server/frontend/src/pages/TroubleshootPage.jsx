import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Wifi,
  Mail,
  HardDrive,
  Globe,
  PlugZap,
  RefreshCw,
  Power,
  Loader2,
  ExternalLink,
  Wrench,
  CircleHelp,
} from "lucide-react";
import api from "../lib/api";
import Page from "../components/ui/Page.jsx";
import SettingsCard from "../components/settings/SettingsCard.jsx";
import SettingsRow from "../components/settings/SettingsRow.jsx";
import Button from "../components/ui/Button.jsx";
import CollapsibleSection from "../components/common/CollapsibleSection.jsx";
import ConfirmModal from "../components/cards/ConfirmModal.jsx";
import { useAuth } from "../hooks/useAuth";
import { getNetworkReport } from "../lib/network-api";
import { getConnectStatus } from "../lib/connect-api";

/**
 * Troubleshooting — a plain-language page for users who hit an error.
 *
 * Two sections, in order:
 *   1. Quick status check — live diagnostics for the things a server needs.
 *   2. Work through these steps — generic fixes that apply to most problems.
 *
 * Error messages around the app link here with ?issue=<id> instead of
 * repeating the same generic advice inline.
 */

const PASS = "pass";
const FAIL = "fail";
const WARN = "warn";
const INFO = "info";

const PILL_LABEL = { [PASS]: "OK", [FAIL]: "Needs attention", [WARN]: "Attention", [INFO]: "Not set up" };
// On-card status chips use the app's tinted-chip convention (same as the
// "X available" chip on System Updates / About): text-primary on a /20 fill
// with /30 border. text-primary contrasts with the tint in BOTH themes —
// black-on-light in dark mode, white-on-dark in light mode — unlike the
// status-colored text variants, which wash out on cards in dark mode.
const CHIP_TINT = {
  [PASS]: "bg-success/20 border-success/30",
  [FAIL]: "bg-error/20 border-error/30",
  [WARN]: "bg-warning/20 border-warning/30",
  [INFO]: "bg-accent/20 border-accent/30",
};

function StatusChip({ state, children }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-pill text-xs font-medium border-2 text-primary ${CHIP_TINT[state] || CHIP_TINT[INFO]}`}
    >
      {children}
    </span>
  );
}

const STEPS = [
  {
    title: "Restart LibreServ",
    body: "Restarting clears most temporary problems — it's the first thing to try. Your server restarts itself and comes back in about a minute.",
  },
  {
    title: "Check your internet connection",
    body: "LibreServ needs the internet to reach your apps, send email, and download updates. If a check above says there's no connection: check that your Wi-Fi or router is on, restart your router if you can, and make sure other devices can get online. If your server is plugged into your router, check the cable.",
  },
  {
    title: "Make sure LibreServ is up to date",
    body: "Updates fix bugs. Go to Settings → System Updates and install any update that's available.",
  },
  {
    title: "Still stuck? Contact support",
    body: "If you've worked through the steps above and things still aren't working, contact support and include: which version of LibreServ you're running, what stopped working, and which checks above failed. (A support contact page is coming soon.)",
  },
];

export default function TroubleshootPage() {
  const { request } = useAuth();
  const [searchParams] = useSearchParams();
  const issue = searchParams.get("issue");

  const [restartModal, setRestartModal] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  const connectRowRef = useRef(null);

  const { data: checks, isFetching: running, refetch } = useQuery({
    queryKey: ["troubleshoot-checks"],
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      // Every request is allowed to fail — a down server shouldn't blank the
      // page; each check falls back to a "couldn't check" state instead.
      const [healthRes, netRes, proxyRes, connectRes] = await Promise.allSettled([
        api("/system/health/check", { allowNonOk: true }).then((r) => r.json()),
        getNetworkReport(),
        api("/settings/proxy", { allowNonOk: true }).then((r) => r.json()),
        getConnectStatus(),
      ]);

      const health = healthRes.status === "fulfilled" ? healthRes.value : null;
      const net = netRes.status === "fulfilled" ? netRes.value : null;
      const proxy = proxyRes.status === "fulfilled" ? proxyRes.value : null;
      const connect = connectRes.status === "fulfilled" ? connectRes.value : null;

      const hc = health?.checks || {};
      const serverOk = ["api_server", "database", "runtime"].every((k) => hc[k]?.status === "passed");
      const smtp = hc.smtp;
      const tunnel = Boolean(net?.connect?.active && net?.connect?.tunnel_ok);
      const v4 = Boolean(net?.stacks?.v4?.inbound_open);
      const v6 = Boolean(net?.stacks?.v6?.inbound_open);
      const domain = proxy?.proxy?.default_domain;
      const domainOk = Boolean(domain && domain !== "localhost" && domain !== "127.0.0.1");

      return {
        server: serverOk
          ? { state: PASS, detail: "The LibreServ software is running normally." }
          : { state: FAIL, detail: "The LibreServ software isn't running properly. Try the restart step below." },
        internet: !net
          ? { state: INFO, detail: "Couldn't check your internet connection right now." }
          : tunnel || v4 || v6
            ? { state: PASS, detail: net.headline || "Your server can be reached from the internet." }
            : { state: WARN, detail: net.headline || "Only people on your home network can use your apps right now. Check your internet connection in the steps below." },
        email: !smtp
          ? { state: INFO, detail: "Couldn't check email sending." }
          : smtp.status === "passed" && !smtp.details?.optional
            ? { state: PASS, detail: "Email sending is set up and reachable." }
            : smtp.details?.optional
              ? { state: INFO, detail: "Email sending isn't set up yet — that's okay, most things still work without it." }
              : { state: FAIL, detail: "Email sending isn't working. Try the restart step below." },
        storage: !hc.disk_space
          ? { state: INFO, detail: "Couldn't check storage space." }
          : hc.disk_space.status === "passed"
            ? { state: PASS, detail: `${hc.disk_space.message || "Plenty of storage space."}` }
            : { state: FAIL, detail: hc.disk_space.message || "Storage is running low." },
        domain: domainOk
          ? { state: PASS, detail: `Your server has a domain name: ${domain}` }
          : { state: INFO, detail: "No domain name set up yet — only needed if you want your apps at addresses like app.yourname.com." },
        connect: !connect
          ? { state: INFO, detail: "Couldn't check LibreServ Connect." }
          : connect.connected
            ? { state: PASS, detail: "LibreServ Connect is connected." }
            : { state: INFO, detail: "Not connected. Only needed for email, a domain name, cloud backups, and remote access through LibreServ." },
      };
    },
  });

  const displayChecks = checks ?? {
    server: { state: INFO, detail: "Checking…" },
    internet: { state: INFO, detail: "Checking…" },
    email: { state: INFO, detail: "Checking…" },
    storage: { state: INFO, detail: "Checking…" },
    domain: { state: INFO, detail: "Checking…" },
    connect: { state: INFO, detail: "Checking…" },
  };

  // Deep link: ?issue=connect-key highlights the Connect row and opens step 1.
  useEffect(() => {
    if (issue === "connect-key") {
      const t = setTimeout(() => connectRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 250);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [issue]);

  const handleRestart = async () => {
    setRestartModal(false);
    setRestarting(true);
    setRestartFailed(false);
    try {
      await request("/system/restart", { method: "POST" });
    } catch {
      // The server starts shutting down immediately; a dropped connection is
      // expected and counts as "restart started".
    }
    // Poll health until the server is back (or give up after 2 minutes).
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const res = await fetch("/health", { cache: "no-store" });
        if (res.ok) {
          window.location.reload();
          return;
        }
      } catch {
        // still down — keep polling
      }
    }
    setRestarting(false);
    setRestartFailed(true);
  };

  const checkRows = [
    { id: "server", icon: Activity, title: "Server is running", ...displayChecks.server },
    { id: "internet", icon: Wifi, title: "Internet connection", ...displayChecks.internet },
    { id: "email", icon: Mail, title: "Email sending", ...displayChecks.email },
    { id: "storage", icon: HardDrive, title: "Storage space", ...displayChecks.storage },
    { id: "domain", icon: Globe, title: "Domain name", ...displayChecks.domain },
    { id: "connect", icon: PlugZap, title: "LibreServ Connect", ...displayChecks.connect },
  ];

  return (
    <Page title="Troubleshooting">
      <div className="space-y-6">
        {issue === "connect-key" && (
          <div
            data-slot="troubleshoot-notice"
            className="flex items-start gap-3 rounded-large-element border-2 border-warning/30 bg-warning/20 p-3"
            role="status"
          >
            <CircleHelp size={18} className="text-warning shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-sm text-secondary">
              A Connect key didn't work. The check below shows the current state — then work through the steps to get things running again.
            </p>
          </div>
        )}

        {/* ─── Section 1: live checks ─────────────────────────────────── */}
        <SettingsCard
          icon={Activity}
          title="Quick status check"
          index={0}
          headerActions={
            <Button
              variant="primary"
              size="sm"
              onClick={() => refetch()}
              disabled={running}
              loading={running}
            >
              <RefreshCw size={16} /> Re-run checks
            </Button>
          }
        >
          <p className="px-4 pb-1 text-sm text-accent">
            These are the things your server needs to work. A passing check means it's fine. If something isn't, the fix is usually in the steps below.
          </p>
          <div className="px-4 pb-4">
            {checkRows.map((row, i) => {
              const isConnect = row.id === "connect";
              return (
                <div key={row.id} ref={isConnect ? connectRowRef : undefined}>
                  <SettingsRow
                    label={
                      <span className="inline-flex items-center gap-2">
                        <row.icon size={16} className="text-accent shrink-0" aria-hidden="true" />
                        {row.title}
                      </span>
                    }
                    description={row.detail}
                    hideDivider={i === checkRows.length - 1}
                  >
                    <StatusChip state={row.state}>{PILL_LABEL[row.state]}</StatusChip>
                  </SettingsRow>
                </div>
              );
            })}
          </div>
        </SettingsCard>

        {/* ─── Section 2: step-by-step fixes ──────────────────────────── */}
        <SettingsCard icon={Wrench} title="Work through these steps" index={1}>
          <p className="px-4 pb-1 text-sm text-accent">
            If a check above failed — or you came here from an error message — try these in order.
          </p>
          <div className="px-4 pb-4">
            {STEPS.map((step, i) => (
              <CollapsibleSection
                key={i}
                pill
                defaultOpen={issue === "connect-key" ? i === 0 : false}
                className="mb-2 last:mb-0"
                title={
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent text-primary font-mono text-xs shrink-0">
                      {i + 1}
                    </span>
                    <span className="text-primary">{step.title}</span>
                  </span>
                }
              >
                <div className="space-y-3">
                  <p className="text-sm text-primary">{step.body}</p>
                  {i === 0 && (
                    <div className="flex items-center gap-3 flex-wrap">
                      <Button onClick={() => setRestartModal(true)} loading={restarting} disabled={restarting}>
                        {restarting ? <Loader2 className="animate-spin" size={16} /> : <Power size={16} />}
                        {restarting ? "Restarting…" : "Restart now"}
                      </Button>
                      {restartFailed && (
                        <span className="text-sm text-error">
                          The server didn't come back. Give it a moment, then check your power and internet connection.
                        </span>
                      )}
                    </div>
                  )}
                  {i === 2 && (
                    <Button asChild variant="outline" size="sm" surface="secondary">
                      <Link to="/settings">
                        <ExternalLink size={14} /> Go to System Updates in Settings
                      </Link>
                    </Button>
                  )}
                </div>
              </CollapsibleSection>
            ))}
          </div>
        </SettingsCard>
      </div>

      <ConfirmModal
        open={restartModal}
        onClose={() => setRestartModal(false)}
        onConfirm={handleRestart}
        icon={Power}
        title="Restart LibreServ?"
        message="Your server will restart itself and take about a minute to come back. You'll stay logged in — this page will come back on its own."
        confirmLabel="Restart"
        variant="warning"
      />
    </Page>
  );
}
