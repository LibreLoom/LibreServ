import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ApiError, getJson } from "../lib/api.js";
import { drivesQuery } from "../lib/dashboardData.js";
import { useAuth } from "../context/AuthContext.jsx";
import { buildNeedsYouItems } from "../lib/needsYou.js";
import { withDevMockDetected } from "../lib/devMockDrives.js";
import useBackupRows from "./useBackupRows.js";
import { useSystemHealthCheck } from "./useSystemHealthCheck.jsx";
import { driveHealthQueryOptions } from "./useDriveHealth.js";
import { detectedDrivesQueryOptions } from "./detectedDrives.js";

const NO_DRIVES = [];

/** @param {{ data: any }[]} results */
const combineData = (results) => results.map((result) => result.data);

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
 */
export default function useNeedsYou() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const userId = user?.id ?? "";

  const drives = useQuery(drivesQuery);
  const detected = useQuery(detectedDrivesQueryOptions(isAdmin));
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

  const driveList = Array.isArray(drives.data) ? drives.data : NO_DRIVES;
  const pluggedIn = useMemo(() => withDevMockDetected(detected.data), [detected.data]);
  const summaryOptions = useMemo(
    () => driveList.map((drive) => {
      const ready = isReady(drive) && drive.mounted !== false;
      return {
        queryKey: ["drive-summary", drive.id],
        queryFn: () => getJson(`/api/v1/drives/${drive.id}/summary`),
        enabled: isAdmin && ready,
        staleTime: 30_000,
        refetchInterval: ready ? 60_000 : /** @type {const} */ (false),
      };
    }),
    [driveList, isAdmin],
  );
  const healthOptions = useMemo(
    () => driveList.map((drive) => driveHealthQueryOptions(drive, isAdmin)),
    [driveList, isAdmin],
  );
  const summaries = useQueries({ queries: summaryOptions, combine: combineData });
  const health = useQueries({ queries: healthOptions, combine: combineData });

  const items = useMemo(() => {
    /** @type {Record<string, any>} */
    const driveSummaries = {};
    /** @type {Record<string, any>} */
    const driveHealth = {};
    driveList.forEach((drive, index) => {
      driveSummaries[drive.id] = summaries[index];
      driveHealth[drive.id] = health[index];
    });
    return buildNeedsYouItems({
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
      detected: pluggedIn,
    });
  }, [isAdmin, userId, driveList, drives.isSuccess, summaries, health, systemChecks.data,
    backupRowsResult.rows, backupRowsResult.phrase, connect.data, network.data, pluggedIn]);

  return {
    items,
    isLoading: drives.isLoading || backupRowsResult.isLoading,
    drives,
    driveList,
    pluggedIn,
    systemChecks,
    rows: backupRowsResult.rows,
    phrase: backupRowsResult.phrase,
  };
}
