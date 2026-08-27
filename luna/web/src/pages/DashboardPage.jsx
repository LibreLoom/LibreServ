import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, HardDrive, PlugZap, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import Page from "../components/ui/Page.jsx";
import Card from "../components/cards/Card.jsx";
import Button from "../components/ui/Button.jsx";
import Pill from "../components/common/Pill.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import TextLink from "../components/ui/TextLink.jsx";
import { TermHint } from "../components/ui/Tooltip.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { dashboard as greetingMessages } from "../assets/greetings.jsx";
import { ApiError, getDrives, getHealth, getJson } from "../lib/api.js";

const STATE_PILLS = {
  as_is: "success",
  readonly: "warning",
  missing: "warning",
  ejected: "info",
  failed: "error",
};

const STATE_LABELS = {
  as_is: "Ready",
  readonly: "Read only",
  missing: "Unplugged",
  ejected: "Safely removed",
  failed: "Needs help",
};

/** Decimal sizes, matching DrivesPage. */
function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return "";
  const n = Number(bytes);
  if (n < 1000) return `${Math.round(n)} B`;
  const kb = n / 1000;
  if (kb < 1000) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1000;
  if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1000;
  if (gb < 1000) return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
  const tb = gb / 1000;
  return `${tb < 10 ? tb.toFixed(1) : Math.round(tb)} TB`;
}

function folderHref(driveId, folderPath) {
  if (!folderPath) return `/drives/${driveId}`;
  return `/drives/${driveId}?path=${encodeURIComponent(folderPath)}`;
}

function shortcutLabel(path) {
  const parts = String(path || "")
    .split("/")
    .filter(Boolean);
  return parts[parts.length - 1] || path;
}

function countLine(folders, files) {
  if (folders == null && files == null) return null;
  const folderN = Number(folders) || 0;
  const fileN = Number(files) || 0;
  const folderBit = `${folderN} folder${folderN === 1 ? "" : "s"}`;
  const fileBit = `${fileN} file${fileN === 1 ? "" : "s"}`;
  return `${folderBit} · ${fileBit} at the top`;
}

function DriveStateLabel({ state }) {
  const label = STATE_LABELS[state] || state;
  if (state === "readonly") {
    return (
      <TermHint content="Luna can open files on this drive but cannot save changes here.">
        {label}
      </TermHint>
    );
  }
  return label;
}

/**
 * Home drive card — storage, top-level counts, and folder shortcuts from
 * GET /api/v1/drives/{id}/summary. Never invents numbers when the drive is
 * unplugged or the summary is still loading.
 *
 * @param {{ drive: { id: string, label?: string, state: string } }} props
 */
function DriveHomeCard({ drive }) {
  const ready = drive.state === "as_is" || drive.state === "readonly";
  const summary = useQuery({
    queryKey: ["drive-summary", drive.id],
    queryFn: () => getJson(`/api/v1/drives/${drive.id}/summary`),
    enabled: ready,
    staleTime: 30_000,
    refetchInterval: ready ? 60_000 : false,
  });

  const data = summary.data;
  const freeLabel = formatBytes(data?.free_bytes);
  const totalLabel = formatBytes(data?.total_bytes);
  const usedLabel = formatBytes(data?.used_bytes);
  const hasSpace =
    data?.mounted &&
    data?.total_bytes != null &&
    Number(data.total_bytes) > 0 &&
    freeLabel &&
    totalLabel;
  const usedPct = hasSpace
    ? Math.min(100, Math.round((Number(data.used_bytes) / Number(data.total_bytes)) * 100))
    : 0;
  const counts = countLine(data?.folders, data?.files);
  const shortcuts = Array.isArray(data?.shortcuts) ? data.shortcuts : [];
  const variant = STATE_PILLS[drive.state] || "info";

  let body;
  if (!ready) {
    body = (
      <div className="space-y-3">
        <p className="text-primary text-sm">
          {drive.state === "missing"
            ? "This drive is unplugged. Plug it back in to see files and space."
            : drive.state === "ejected"
              ? "Safely removed. Plug it in again when you need it."
              : "Luna ran into a problem with this drive. Open Drives for details."}
        </p>
        <Button size="sm" variant="outline" asChild>
          <Link to="/drives">Open Drives</Link>
        </Button>
      </div>
    );
  } else if (summary.isError) {
    body = (
      <p className="text-primary text-sm">Open this drive to see your files.</p>
    );
  } else {
    body = (
      <div className="space-y-4">
        {hasSpace ? (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span
                className="inline-block h-2 w-2 rounded-full bg-primary shrink-0"
                aria-hidden="true"
              />
              <span className="text-xs font-mono uppercase tracking-widest text-accent">
                Storage
              </span>
            </div>
            <div className="text-2xl font-mono font-normal leading-tight text-primary">
              {freeLabel} free
            </div>
            <p className="text-primary text-sm mt-1">
              {usedLabel ? `${usedLabel} used · ` : ""}
              {totalLabel} total
            </p>
            <div
              className="mt-3 h-2 rounded-pill bg-primary overflow-hidden"
              role="progressbar"
              aria-valuenow={usedPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${usedPct}% used`}
            >
              <div
                className="h-full rounded-pill bg-accent motion-safe:transition-all motion-safe:duration-500"
                style={{ width: `${usedPct}%` }}
              />
            </div>
          </div>
        ) : summary.isLoading ? (
          <p className="text-primary text-sm">Checking space…</p>
        ) : (
          <p className="text-primary text-sm">Open this drive to see your files.</p>
        )}

        {counts ? <p className="text-primary text-sm">{counts}</p> : null}

        {shortcuts.length > 0 ? (
          <div>
            <div className="text-xs font-mono uppercase tracking-widest text-accent mb-2">
              Folders
            </div>
            <div className="flex flex-wrap gap-2">
              {shortcuts.map((path) => (
                <Button key={path} size="sm" variant="outline" asChild>
                  <Link to={folderHref(drive.id, path)}>{shortcutLabel(path)}</Link>
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <Button size="sm" variant="primary" asChild>
            <Link to={`/drives/${drive.id}`}>Browse files</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Card
      icon={HardDrive}
      title={drive.label || "Drive"}
      headerActions={
        <Pill variant={variant}>
          <DriveStateLabel state={drive.state} />
        </Pill>
      }
    >
      {body}
    </Card>
  );
}

function getGreeting() {
  const today = new Date();
  const month = today.getMonth();
  const date = today.getDate();

  if (month === 0 && date === 1) return "Happy New Year, ";
  if (month === 2 && date === 8) return "Happy International Women's Day, ";
  if (month === 2 && date === 21) return "Happy Nowruz, ";
  if (month === 3 && date === 22) return "Happy Earth Day, ";
  if (month === 4 && date === 1) return "Happy Labour Day, ";
  if (month === 5 && date === 19) return "Happy Juneteenth, ";
  if (month === 9 && date === 31) return "Happy Halloween, ";
  if (month === 10 && date === 1) return "Happy Diwali, ";
  if (month === 11 && date === 25) return "Merry Christmas, ";
  if (month === 11 && date === 26) return "Happy Kwanzaa, ";
  if (month === 6 && date === 4) return "Happy Independence Day, ";

  const hoursSinceEpoch = Math.floor(today.getTime() / 43200000);
  return greetingMessages[hoursSinceEpoch % greetingMessages.length];
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} min${minutes !== 1 ? "s" : ""}`);
  if (days === 0 && hours === 0 && secs > 0) parts.push(`${secs} sec${secs !== 1 ? "s" : ""}`);

  return parts.join(" ") || "0 secs";
}

async function getJsonSkipForbidden(path) {
  try {
    return await getJson(path);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
      return null;
    }
    throw err;
  }
}

function UptimeCard({ value }) {
  return (
    <Card data-slot="uptime-card">
      <div className="flex items-center gap-2 mb-1">
        <span
          className="inline-block h-2 w-2 rounded-full bg-primary shrink-0"
          aria-hidden="true"
        />
        <span className="text-xs font-mono uppercase tracking-widest text-accent">
          Uptime
        </span>
      </div>
      <div className="text-3xl font-mono font-normal leading-tight text-primary">{value}</div>
    </Card>
  );
}

function connectionHeadline(net) {
  if (!net) return "Checking this network…";
  if (!net.ethernet_connected) {
    return "Not on a network yet";
  }
  if (net.has_default_route === false) {
    return "No internet route";
  }
  return "On this network";
}

function connectionDetail(net) {
  if (!net) return "Luna is checking the network connection.";
  if (net.ethernet_connected) return "Plugged in with a cable.";
  return "Plug Luna into your router or modem with the included RJ45 (ethernet) cable.";
}

function connectionDotClass(net) {
  if (!net) return "bg-accent";
  if (net.ethernet_connected) return "bg-primary";
  return "bg-warning";
}

/**
 * ConnectionCard — same metric language as UptimeCard: quiet eyebrow, live
 * dot, large mono status. Remote access is one full-width pill (status +
 * link), not a badge stacked on a separate button.
 *
 * @param {{
 *   net: any,
 *   isAdmin: boolean,
 *   remoteOn: boolean,
 *   remoteDomain?: string,
 * }} props
 */
function ConnectionCard({ net, isAdmin, remoteOn, remoteDomain }) {
  return (
    <Card data-slot="connection-card">
      <div className="flex items-center gap-2 mb-1">
        <span
          className={cn("inline-block h-2 w-2 rounded-full shrink-0", connectionDotClass(net))}
          aria-hidden="true"
        />
        <span className="text-xs font-mono uppercase tracking-widest text-accent">
          Connection
        </span>
      </div>
      <div className="text-3xl font-mono font-normal leading-tight text-primary">
        {connectionHeadline(net)}
      </div>
      <p className="text-primary text-sm mt-2">{connectionDetail(net)}</p>
      {isAdmin && (
        <Button
          size="md"
          variant="primary"
          asChild
          fullWidth
          className="mt-4 justify-between"
        >
          <Link
            to="/settings#remote"
            aria-label={remoteOn ? "Remote access on" : "Remote access off"}
          >
            <span>{remoteOn ? "Remote access on" : "Remote access off"}</span>
            <span className="flex items-center gap-2">
              {remoteOn && remoteDomain ? (
                <span className="font-mono">{remoteDomain}</span>
              ) : null}
              <ChevronRight size={16} aria-hidden="true" />
            </span>
          </Link>
        </Button>
      )}
    </Card>
  );
}

function jobLabel(job) {
  const kind = String(job.kind || "").toLowerCase();
  if (kind.includes("move")) return "Moving files";
  if (kind.includes("copy")) return "Copying files";
  return "Working on files";
}

export default function DashboardPage() {
  const greeting = useMemo(() => getGreeting(), []);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const health = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: 30_000,
  });
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const detected = useQuery({
    queryKey: ["drives-detected"],
    queryFn: () => getJson("/api/v1/drives/detected"),
    refetchInterval: 5000,
    enabled: isAdmin,
  });
  const network = useQuery({
    queryKey: ["network-status"],
    queryFn: () => getJson("/api/v1/network/status"),
  });
  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJsonSkipForbidden("/api/v1/connect/status"),
    enabled: isAdmin,
  });
  const jobs = useQuery({
    queryKey: ["jobs-recent"],
    queryFn: () => getJsonSkipForbidden("/api/v1/jobs?limit=5"),
  });
  const access = useQuery({
    queryKey: ["my-access"],
    queryFn: () => getJson("/api/v1/me/access"),
    enabled: !isAdmin,
  });

  const uptimeDataRef = useRef({ serverUptime: 0, fetchTime: 0 });
  const getDisplayUptime = useCallback(() => {
    const { serverUptime, fetchTime } = uptimeDataRef.current;
    if (fetchTime === 0) return "…";
    const elapsed = (Date.now() - fetchTime) / 1000;
    return formatUptime(Math.floor(serverUptime + elapsed));
  }, []);
  const [displayUptime, setDisplayUptime] = useState(getDisplayUptime);

  useEffect(() => {
    const seconds = health.data?.uptime_seconds;
    if (seconds == null) return;
    uptimeDataRef.current = {
      serverUptime: Number(seconds) || 0,
      fetchTime: Date.now(),
    };
  }, [health.data?.uptime_seconds]);

  useEffect(() => {
    const interval = setInterval(() => {
      setDisplayUptime(getDisplayUptime());
    }, 1000);
    return () => clearInterval(interval);
  }, [getDisplayUptime]);

  const greetingBase = greeting.endsWith(", ") ? greeting.slice(0, -2) : greeting;
  const showUsername = user?.username;
  const greetingTitle = (
    <span className="inline-flex flex-wrap items-center justify-center gap-2">
      <span>{showUsername ? `${greetingBase},` : greetingBase}</span>
      <span
        className={cn(
          "transition-all duration-300 ease-out motion-reduce:transition-none",
          showUsername ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1",
        )}
        aria-hidden={!showUsername}
      >
        {showUsername ? user.username : ""}
      </span>
    </span>
  );

  const adopted = Array.isArray(drives.data) ? drives.data : [];
  const pluggedIn = Array.isArray(detected.data) ? detected.data : [];
  const attentionDrives = adopted.filter(
    (drive) => drive.state === "missing" || drive.state === "failed",
  );
  const recentJobs = Array.isArray(jobs.data) ? jobs.data : [];
  const grants = Array.isArray(access.data) ? access.data : [];
  const remoteOn = Boolean(connect.data?.enabled && connect.data?.tunnel_active);
  const remoteDomain = connect.data?.domain;

  return (
    <Page
      data-slot="dashboard-page"
      title={greetingTitle}
      titleId="dashboard-title"
      padded={false}
      headerClassName="px-8 mb-10"
      headerCardClassName="group"
    >
      <section
        className="flex flex-col md:flex-row gap-8 px-8 w-full"
        aria-label="Home overview"
      >
        <div className="grid grid-cols-1 gap-6 flex-1 content-start order-1 md:order-0">
          <UptimeCard value={displayUptime} />
          <ConnectionCard
            net={network.data}
            isAdmin={isAdmin}
            remoteOn={remoteOn}
            remoteDomain={remoteDomain}
          />
          {recentJobs.length > 0 && (
            <Card title="Recent copies">
              <ul className="space-y-3">
                {recentJobs.map((job) => (
                  <li key={job.id} className="flex items-center justify-between gap-3">
                    <span className="text-primary text-sm">{jobLabel(job)}</span>
                    <Pill variant={job.state === "failed" ? "error" : "info"}>
                      {job.state === "done"
                        ? "Finished"
                        : job.state === "failed"
                          ? "Stopped"
                          : "In progress"}
                    </Pill>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="flex-1 grid grid-cols-1 gap-6 content-start order-2 md:order-1">
          {adopted.map((drive) => (
            <DriveHomeCard key={drive.id} drive={drive} />
          ))}

          {isAdmin && pluggedIn.length > 0 && (
            <Card icon={PlugZap} title="New drive plugged in">
              <p className="text-primary text-sm">
                Luna noticed a USB drive. Open Drives to look inside — nothing
                on the drive changes until you choose.
              </p>
              <div className="mt-3">
                <Button size="sm" variant="primary" asChild>
                  <Link to="/drives">Look inside</Link>
                </Button>
              </div>
            </Card>
          )}

          {attentionDrives.length > 0 && (
            <Card icon={TriangleAlert} title="Needs a look">
              <ul className="space-y-2">
                {attentionDrives.map((drive) => (
                  <li key={drive.id} className="text-primary text-sm">
                    {drive.label}{" "}
                    {drive.state === "missing"
                      ? "is unplugged."
                      : "ran into a problem."}
                  </li>
                ))}
              </ul>
              <div className="mt-3">
                <Button size="sm" variant="outline" asChild>
                  <Link to="/drives">Open Drives</Link>
                </Button>
              </div>
            </Card>
          )}

          {!drives.isLoading && adopted.length === 0 && (
            <EmptyState
              icon={HardDrive}
              title="No drives yet"
              description="Plug a USB drive into Luna. It will show up here in a few seconds, and Luna will not change anything on it until you ask."
              action={
                <Button size="sm" variant="primary" asChild>
                  <Link to="/drives">Go to Drives</Link>
                </Button>
              }
            />
          )}

          {!isAdmin && grants.length > 0 && (
            <Card title="Folders shared with you">
              <ul className="space-y-3">
                {grants.map((grant) => (
                  <li key={grant.id} className="flex items-center justify-between gap-3">
                    <span className="text-primary text-sm">
                      {grant.drive_label}
                      {grant.path ? ` · ${grant.path}` : ""}
                    </span>
                    <TextLink surface="secondary" to={`/drives/${grant.drive_id}`}>
                      Open
                    </TextLink>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </section>
    </Page>
  );
}
