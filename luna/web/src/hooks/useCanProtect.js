import { useQuery } from "@tanstack/react-query";
import { getDrives, getJson } from "../lib/api";
import { canProtect } from "../lib/canProtect";

/**
 * True when Protect should appear: two+ drives, or cloud backup connected.
 * Logical OR — not bitwise.
 */
export default function useCanProtect(enabled = true) {
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives, enabled });
  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
    enabled,
  });
  return canProtect({
    driveCount: (drives.data || []).length,
    cloudBackupConnected: Boolean(connect.data?.backup_unlocked),
  });
}
