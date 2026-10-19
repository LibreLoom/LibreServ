import { useQueries, useQuery } from "@tanstack/react-query";
import { ApiError, getDrives, getJson } from "../lib/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { buildNeedsYouItems } from "../lib/needsYou.js";
import { withDevMockDetected } from "../lib/devMockDrives.js";
import useBackupRows from "./useBackupRows.js";
import { useSystemHealthCheck } from "./useSystemHealthCheck.jsx";

/** A drive Luna can browse: as is, or read only. */
function isReady(drive) {
  return drive.state === "as_is" || drive.state === "readonly";
}

/**
 * A 401 or 403 from Connect is treated as no status (null), not as a failure.
 * @param {string} path
 */
async function getJsonSkipForbidden(path) {
  try {
    return await getJson(path);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return null;
    }
    throw err;
  }
}

/**
 * Every query the Needs you zone reads, with keys shared with the dashboard and
 * the Files page so nothing is fetched twice. Admin-only requests stay disabled
 * for Members.
 *
 * @returns {{ items: import("../lib/needsYou.js").NeedsYouItem[], isLoading: boolean }}
 */
export default function useNeedsYou() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const userId = user?.id ?? "";

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
    enabled: isAdmin,
  });
  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJsonSkipForbidden("/api/v1/connect/status"),
    enabled: isAdmin,
  });
  const systemChecks = useSystemHealthCheck();
  const backupRowsResult = useBackupRows();

  const driveList = Array.isArray(drives.data) ? drives.data : [];

  const summaryQueries = useQueries({
    queries: driveList.map((drive) => {
      const ready = isReady(drive);
      return {
        queryKey: ["drive-summary", drive.id],
        queryFn: () => getJson(`/api/v1/drives/${drive.id}/summary`),
        enabled: isAdmin && ready,
        staleTime: 30_000,
        refetchInterval: ready ? 60_000 : false,
      };
    }),
  });
  const healthQueries = useQueries({
    queries: driveList.map((drive) => ({
      queryKey: ["drive-health", drive.id],
      queryFn: () => getJson(`/api/v1/drives/${drive.id}/health`),
      retry: false,
      enabled: isAdmin && drive.state === "as_is",
    })),
  });

  /** @type {Record<string, any>} */
  const driveSummaries = {};
  /** @type {Record<string, any>} */
  const driveHealth = {};
  driveList.forEach((drive, index) => {
    driveSummaries[drive.id] = summaryQueries[index]?.data;
    driveHealth[drive.id] = healthQueries[index]?.data;
  });

  const items = buildNeedsYouItems({
    isAdmin,
    userId,
    drives: driveList,
    drivesLoading: !drives.isSuccess,
    driveSummaries,
    driveHealth,
    systemChecks: systemChecks.data ?? null,
    backupRows: backupRowsResult.rows,
    phrase: backupRowsResult.phrase,
    connect: connect.data ?? null,
    network: network.data ?? null,
    detected: withDevMockDetected(detected.data),
  });

  return {
    items,
    isLoading: drives.isLoading || backupRowsResult.isLoading,
  };
}
