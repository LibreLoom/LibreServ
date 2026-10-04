import { useQuery } from "@tanstack/react-query";
import { Cloud } from "lucide-react";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { getJson } from "../../../lib/api";
import BackupStatusNotice from "../../common/BackupStatusNotice.jsx";

/**
 * Cloud backup status only — choosing what to copy lives in Protect
 * (open a drive or folder → Protect → In the cloud).
 */
export default function CloudBackupCategory() {
  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
  });

  return (
    <SettingsCard
      icon={Cloud}
      title="Cloud backup"
      headerActions={
        <InfoHint
          label="What cloud backup means"
          content="An off-site copy of the latest files, stored with Luna Connect. It is not a history of old versions."
        />
      }
    >
      {connect.data?.backup_unlocked ? (
        <div className="space-y-3">
          <BackupStatusNotice
            state={connect.data?.backup_status?.state}
            lastError={connect.data?.backup_status?.last_error}
            lastOkAt={connect.data?.backup_status?.last_ok_at}
            staleText="Cloud backup hasn't finished in over a day. Luna copies files to the cloud only while nobody is using it."
          />
          <p className="text-primary text-sm">
            Luna copies the latest files when this Luna is idle — not a history of old versions.
            Cloud backup costs $8 per terabyte each month.
          </p>
          <p className="text-primary text-sm">
            To copy a drive or folder off-site, open it and tap Protect, then use In the cloud.
          </p>
        </div>
      ) : (
        <p className="text-primary text-sm">
          Add a card at connect.luna.libreloom.org, then pair this Luna. After that, open a drive or folder, tap Protect, and turn on In the cloud.
        </p>
      )}
    </SettingsCard>
  );
}
