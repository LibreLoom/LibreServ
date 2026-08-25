import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud } from "lucide-react";
import Button from "../../ui/Button";
import SettingsCard from "../SettingsCard";
import { InfoHint } from "../../ui/Tooltip";
import { getJson, postJson, apiErrorMessage } from "../../../lib/api";
import { useState } from "react";
import PageNotice from "../../common/PageNotice";

export default function CloudBackupCategory() {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);

  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
  });
  const drives = useQuery({
    queryKey: ["drives"],
    queryFn: () => getJson("/api/v1/drives"),
  });
  const saveSources = useMutation({
    mutationFn: (sources) => postJson("/api/v1/connect/backup-sources", { sources }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connect-status"] });
      setError(null);
    },
    onError: (err) => setError(apiErrorMessage(err)),
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
      {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}
      {connect.data?.backup_unlocked ? (
        <div className="space-y-3">
          <p className="text-primary text-sm">
            Luna copies the latest files when this Luna is idle — not a history of old versions.
            Cloud backup costs $7 per terabyte each month.
          </p>
          {(drives.data || []).map((d) => {
            const on = (connect.data.backup_sources || []).some((s) => s.drive_id === d.id);
            return (
              <Button
                key={d.id}
                size="sm"
                variant={on ? "primary" : "outline"}
                onClick={() => {
                  const current = connect.data.backup_sources || [];
                  const next = on
                    ? current.filter((s) => s.drive_id !== d.id)
                    : [...current, { kind: "drive", drive_id: d.id }];
                  saveSources.mutate(next);
                }}
              >
                {on ? `Stop copying ${d.label}` : `Copy whole drive: ${d.label}`}
              </Button>
            );
          })}
        </div>
      ) : (
        <p className="text-primary text-sm">
          Add a card at connect.luna.libreloom.org, then pair this Luna. After that you can copy any folder or a whole drive off-site.
        </p>
      )}
    </SettingsCard>
  );
}
