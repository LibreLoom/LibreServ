import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import DriveStatusPill from "../common/DriveStatusPill.jsx";
import { getJson } from "../../lib/api.js";
import { formatBytes } from "../../lib/formatBytes.js";
import { folderHref as driveFolderHref } from "../../lib/paths.js";
import { CAP, sharedItemAction, sharedItemHref } from "../../lib/access.js";
import { capsOnPath } from "../../lib/shareTree.js";

function folderHref(driveId, folderPath) {
  return driveFolderHref(driveId, folderPath);
}

function shortcutLabel(path) {
  const parts = String(path || "")
    .split("/")
    .filter(Boolean);
  return parts[parts.length - 1] || path;
}

function pathDepth(path) {
  return String(path || "")
    .split("/")
    .filter(Boolean).length;
}

/**
 * Home drive card: free space (only when the drive really reported it),
 * folder shortcuts as pill buttons, and the way into the files. Reads
 * GET /api/v1/drives/{id}/summary and never invents numbers while the drive is
 * unplugged or the summary is still loading.
 *
 * @param {{
 *   drive: { id: string, label?: string, state: "as_is" | "readonly" | "missing" | "ejected" | "failed" },
 *   isAdmin?: boolean,
 *   grants?: any[],
 *   showSeeAllShared?: boolean,
 * }} props
 */
export default function DriveHomeCard({
  drive,
  isAdmin = false,
  grants = [],
  showSeeAllShared = false,
}) {
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
  // Storage only shows when the drive really reported its space.
  const hasSpace = Boolean(
    data?.mounted &&
      data?.total_bytes != null &&
      Number(data.total_bytes) > 0 &&
      freeLabel &&
      totalLabel,
  );
  const usedLabel = formatBytes(data?.used_bytes);
  const usedRatio = hasSpace ? Number(data.used_bytes) / Number(data.total_bytes) : 0;
  const usedPct = Number.isFinite(usedRatio) ? Math.min(100, Math.round(usedRatio * 100)) : 0;
  const shortcuts = Array.isArray(data?.shortcuts) ? data.shortcuts : [];

  // A member without view on the drive root lands on a 403 if the card
  // links there, so point their open button at the shallowest grant instead
  // (whole-drive grants keep `/drives/{id}`). Admins always browse the root.
  const canBrowseRoot =
    isAdmin || (capsOnPath(grants, drive.id, "") & CAP.VIEW) !== 0;
  const entryGrant = grants.reduce(
    (best, grant) => (!best || pathDepth(grant.path) < pathDepth(best.path) ? grant : best),
    /** @type {any} */ (null),
  );
  const deepLink = !isAdmin && !canBrowseRoot && Boolean(entryGrant);
  const openHref = deepLink ? sharedItemHref(entryGrant) : `/drives/${drive.id}`;
  const openLabel = deepLink ? sharedItemAction(entryGrant) : "Browse files";

  const openButton = (
    <Button size="sm" variant="primary" asChild>
      <Link to={openHref}>{openLabel}</Link>
    </Button>
  );
  const seeAllButton =
    showSeeAllShared && !isAdmin ? (
      <Button size="sm" variant="outline" asChild>
        <Link to="/shared">See all shared items</Link>
      </Button>
    ) : null;

  let body;
  if (!ready) {
    body = (
      <div className="space-y-3">
        <p className="text-primary text-sm">
          {drive.state === "missing"
            ? "Unplugged. Plug it back in when you want its files and space here."
            : drive.state === "ejected"
              ? "Safely removed. Plug it in again when you need it."
              : isAdmin
                ? "Luna ran into a problem with this drive. Open Drives for details."
                : "Luna ran into a problem with this drive. Ask an Admin to check it."}
        </p>
        {drive.state === "failed" && isAdmin ? (
          <Button size="sm" variant="outline" asChild>
            <Link to="/drives">Open Drives</Link>
          </Button>
        ) : null}
      </div>
    );
  } else if (summary.isError) {
    const showOpen = !isAdmin && Boolean(entryGrant);
    body = (
      <div className="space-y-3">
        <p className="text-primary text-sm">Open this drive to see your files.</p>
        {showOpen || seeAllButton ? (
          <div className="flex flex-wrap gap-2">
            {showOpen ? openButton : null}
            {seeAllButton}
          </div>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        {hasSpace ? (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span
                className="inline-block h-2 w-2 rounded-full surface-primary shrink-0"
                aria-hidden="true"
              />
              <span className="text-xs font-mono">Storage</span>
            </div>
            <div className="text-2xl font-mono font-normal leading-tight text-primary">
              {freeLabel} free
            </div>
            <p className="text-primary text-sm mt-1">
              {usedLabel ? `${usedLabel} used · ` : ""}
              {totalLabel} total
            </p>
            <div
              className="mt-3 h-2 rounded-pill surface-primary p-0.5 overflow-hidden"
              role="progressbar"
              aria-valuenow={usedPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${usedPct}% used`}
            >
              <div
                className="h-full rounded-pill surface-secondary motion-safe:transition-[width] motion-safe:duration-500"
                style={{ width: `${usedPct}%` }}
              />
            </div>
          </div>
        ) : null}

        {shortcuts.length > 0 ? (
          <div>
            <div className="text-xs font-mono mb-2">Folders</div>
            <div className="flex flex-wrap gap-2">
              {shortcuts.map((path) => (
                <Button key={path} size="sm" variant="outline" asChild>
                  <Link to={folderHref(drive.id, path)}>{shortcutLabel(path)}</Link>
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {openButton}
          {seeAllButton}
        </div>
      </div>
    );
  }

  return (
    <Card
      icon={HardDrive}
      title={drive.label || "Drive"}
      headerActions={<DriveStatusPill drive={drive} />}
    >
      {body}
    </Card>
  );
}
