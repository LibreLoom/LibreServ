import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import Button from "../../ui/Button";
import Pill from "../../common/Pill";
import SettingsCard from "../SettingsCard";
import { getJson, postJson, apiErrorMessage } from "../../../lib/api";
import PageNotice from "../../common/PageNotice";

export default function UpdatesCategory() {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);

  const updates = useQuery({
    queryKey: ["system-updates"],
    queryFn: () => getJson("/api/v1/system/updates"),
  });

  const check = useMutation({
    mutationFn: () => getJson("/api/v1/system/updates?force=true"),
    onSuccess: (data) => {
      queryClient.setQueryData(["system-updates"], data);
      setError(null);
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const apply = useMutation({
    mutationFn: () => postJson("/api/v1/system/updates/apply", {}),
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const info = updates.data || {};

  return (
    <SettingsCard
      icon={Download}
      title="Software updates"
      headerActions={
        info.update_available ? <Pill variant="warning">New</Pill> : <Pill variant="success">Current</Pill>
      }
    >
      {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}
      <p className="text-primary text-sm">
        This Luna is on {info.current_version || "unknown"}.
        {info.update_available
          ? ` A newer version (${info.latest_version}) is ready.`
          : " You're on the latest Luna software."}
        {" "}Updates only install when you tap the button — Luna never installs them on its own.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" loading={check.isPending} onClick={() => check.mutate()}>
          Check for updates
        </Button>
        {info.update_available && (
          <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate()}>
            Install update
          </Button>
        )}
      </div>
      {apply.isSuccess && (
        <p className="text-primary text-sm mt-3">
          The new software is installed. Luna will restart in a moment — sign in again after it comes back.
        </p>
      )}
    </SettingsCard>
  );
}
