import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import DriveStatusPill from "../common/DriveStatusPill.jsx";
import DriveCard from "../drives/DriveCard.jsx";
import useDriveHealth from "../../hooks/useDriveHealth.js";
import UnlockPrompt from "../drives/UnlockPrompt.jsx";
import { isLocked, isUnopenable } from "../../lib/drives.js";
import { getJson } from "../../lib/api.js";
import { formatBytes } from "../../lib/formatBytes.js";
import { folderHref as driveFolderHref } from "../../lib/paths.js";
import { CAP, sharedItemAction, sharedItemHref } from "../../lib/access.js";
import { capsOnPath } from "../../lib/shareTree.js";

const CANT_OPEN_HINT =
  "Unplug the drive, wait a few seconds, and plug it back in. If Luna still cannot open it, the drive can be damaged.";

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
 * Home drive card, in two layers: a tray that carries the way in, and a panel
 * that carries the drive itself — free space (only when the drive really
 * reported it), folder shortcuts as pill buttons, and its status. Reads
 * GET /api/v1/drives/{id}/summary and never invents numbers while the drive is
 * unplugged or the summary is still loading.
 *
 * The tray's foot is the shelf (DriveCard): it holds the card's single action —
 * Open, the grant's own label, or Open Files — and stays empty when there is
 * nothing to press, so a column of drives keeps one rhythm without inventing a
 * button that would not work.
 *
 * @param {{
 *   drive: { id: string, label?: string, state: "as_is" | "readonly" | "missing" | "ejected", mounted?: boolean, encrypted?: boolean, locked?: boolean },
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
  const locked = isLocked(drive) && drive.state !== "missing" && drive.state !== "ejected";
  const ready = (drive.state === "as_is" || drive.state === "readonly") && !locked;
  const unopenable = isUnopenable(drive);
  const health = useDriveHealth(drive, isAdmin);
  const summary = useQuery({
    queryKey: ["drive-summary", drive.id],
    queryFn: () => getJson(`/api/v1/drives/${drive.id}/summary`),
    enabled: ready && !unopenable,
    staleTime: 30_000,
    refetchInterval: ready && !unopenable ? 60_000 : false,
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
  // (whole-drive grants keep `/files/{id}`). Admins always browse the root.
  const canBrowseRoot =
    isAdmin || (capsOnPath(grants, drive.id, "") & CAP.VIEW) !== 0;
  const entryGrant = grants.reduce(
    (best, grant) => (!best || pathDepth(grant.path) < pathDepth(best.path) ? grant : best),
    /** @type {any} */ (null),
  );
  const deepLink = !isAdmin && !canBrowseRoot && Boolean(entryGrant);
  const openHref = deepLink ? sharedItemHref(entryGrant) : `/files/${drive.id}`;
  const openLabel = deepLink ? sharedItemAction(entryGrant) : "Open";

  const seeAllButton =
    showSeeAllShared && !isAdmin ? (
      <Button size="sm" variant="outline" surface="primary" asChild>
        <Link to="/shared">See all shared items</Link>
      </Button>
    ) : null;

  let body;
  /** @type {{ label: string, to: string } | null} */
  let shelf = null;
  if (locked) {
    // Anyone who can see the drive may unlock it, so the prompt is right here,
    // and the shelf stays empty: the password field is the action.
    body = (
      <div className="space-y-3">
        <p className="text-sm">Locked. Enter the password to open its files.</p>
        <UnlockPrompt driveId={drive.id} surface="primary" />
      </div>
    );
  } else if (unopenable) {
    body = isAdmin ? (
      <p className="text-sm">
        Luna can't open this drive right now, so its files and free space aren't available.{" "}
        <InfoHint content={CANT_OPEN_HINT} surface="primary" />
      </p>
    ) : (
      <p className="text-sm">Luna can't open this drive right now. Ask an Admin to check it.</p>
    );
    // The Files page still lists the drive, so an Admin keeps a way in.
    if (isAdmin) shelf = { label: "Open Files", to: `/files#drive-${drive.id}` };
  } else if (!ready) {
    body = (
      <p className="text-sm">
        {drive.state === "missing"
          ? "Unplugged. Plug it back in to use its files."
          : "Ejected. To use its files again, unplug it and plug it back in."}
      </p>
    );
  } else if (summary.isError) {
    body = (
      <div className="space-y-3">
        <p className="text-sm">Luna could not load the details of this drive.</p>
        {seeAllButton ? <div className="flex flex-wrap gap-2">{seeAllButton}</div> : null}
      </div>
    );
    // The drive itself is fine; only its details failed. A member with a grant
    // can still open it, and an Admin gets no button rather than a guess.
    if (!isAdmin && entryGrant) shelf = { label: openLabel, to: openHref };
  } else {
    body = (
      <div className="space-y-4">
        {hasSpace ? (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span
                className="inline-block h-2 w-2 rounded-full surface-secondary shrink-0"
                aria-hidden="true"
              />
              <span className="text-xs font-mono">Storage</span>
            </div>
            <div className="text-2xl font-mono font-normal leading-tight">
              {freeLabel} free
            </div>
            <p className="text-sm mt-1">
              {usedLabel ? `${usedLabel} used · ` : ""}
              {totalLabel} total
            </p>
            <div
              className="mt-3 h-2 rounded-pill surface-primary border border-secondary/30 overflow-hidden"
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
                <Button key={path} size="sm" variant="outline" surface="primary" asChild>
                  <Link to={folderHref(drive.id, path)}>{shortcutLabel(path)}</Link>
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {seeAllButton ? <div className="flex flex-wrap gap-2">{seeAllButton}</div> : null}
      </div>
    );
    shelf = { label: openLabel, to: openHref };
  }

  return (
    <DriveCard
      icon={<HardDrive size={ICON_SIZE.lg} />}
      title={drive.label || "Drive"}
      headerActions={<DriveStatusPill drive={drive} health={health.data} />}
      action={shelf}
    >
      {body}
    </DriveCard>
  );
}
