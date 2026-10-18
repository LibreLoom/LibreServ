import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "../lib/api.js";
import { buildBackupRows } from "../lib/backupRows.js";
import { getPhraseStatus, PHRASE_QUERY_KEY } from "../lib/cloudPhrase.js";

/**
 * The one place that reads drive backups, cloud backups and the recovery phrase
 * status. The dashboard page and its Needs you list both call this hook, so they
 * share the same cache entries and each request is made once.
 *
 * rows are empty until both backup lists have answered. A failed cloud list
 * (Connect off) only means no cloud rows.
 *
 * @returns {{
 *   rows: import("../lib/backupRows.js").BackupRow[],
 *   isLoading: boolean,
 *   isError: boolean,
 *   phrase: { set?: boolean, luna_id?: string, check_due?: boolean, [k: string]: any } | null,
 * }}
 */
export default function useBackupRows() {
  const backupsQuery = useQuery({
    queryKey: ["backups"],
    queryFn: () => getJson("/api/v1/backups"),
    retry: false,
  });
  // Connect may be off, so a failed cloud query only means no cloud rows.
  const cloudQuery = useQuery({
    queryKey: ["cloud-backups"],
    queryFn: () => getJson("/api/v1/cloud/backups"),
    retry: false,
  });
  const phraseQuery = useQuery({
    queryKey: PHRASE_QUERY_KEY,
    queryFn: getPhraseStatus,
    retry: false,
  });

  const backupsData = backupsQuery.data;
  const cloudData = cloudQuery.data;
  const cloudSettled = !cloudQuery.isPending;
  const rows = useMemo(
    () => (backupsData && cloudSettled ? buildBackupRows(backupsData, cloudData ?? []) : []),
    [backupsData, cloudData, cloudSettled],
  );

  return {
    rows,
    isLoading: backupsQuery.isPending || cloudQuery.isPending,
    isError: backupsQuery.isError,
    phrase: phraseQuery.data ?? null,
  };
}
