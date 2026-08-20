import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Keyboard } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import Pill from "../components/common/Pill";
import PageNotice from "../components/common/PageNotice";
import { getJson, postJson } from "../lib/api";
import { useAuth } from "../context/AuthContext";

/** Keep in lockstep with lunad `recovery::CARD_*` — printed-card copy. */
export const RECOVERY_CARD = {
  title: "If you forget your password",
  steps: [
    "Plug a USB keyboard into Luna.",
    "Press Esc, then type luna, then press Enter.",
    "On the screen plugged into Luna, type a new password twice.",
  ],
};

export default function SettingsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const updates = useQuery({
    queryKey: ["system-updates"],
    queryFn: () => getJson("/api/v1/system/updates"),
    enabled: user?.role === "admin",
  });

  const check = useMutation({
    mutationFn: () => getJson("/api/v1/system/updates?force=true"),
    onSuccess: (data) => {
      queryClient.setQueryData(["system-updates"], data);
      setError(null);
    },
    onError: (err) => setError(String(err)),
  });
  const apply = useMutation({
    mutationFn: () => postJson("/api/v1/system/updates/apply", {}),
    onError: (err) => setError(String(err)),
  });

  const info = updates.data || {};

  return (
    <Page
      title="Settings"
      titleId="settings-title"
      bottomContent={<p className="text-sm">Keep this password card somewhere safe. Updates only install when you tap the button.</p>}
    >
      {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}
      <div className="grid gap-5 md:grid-cols-2">
        <Card icon={Keyboard} title={RECOVERY_CARD.title}>
          <ol className="space-y-2 text-sm text-primary list-decimal list-inside">
            {RECOVERY_CARD.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="mt-4 text-sm text-primary">
            This only works with a keyboard plugged into Luna. Nobody can reset the password over the internet.
          </p>
        </Card>

        {user?.role === "admin" && (
          <Card
            icon={Download}
            title="Software updates"
            headerActions={
              info.update_available ? <Pill variant="warning">New</Pill> : <Pill variant="success">Current</Pill>
            }
          >
            <p className="text-primary text-sm">
              This Luna is on {info.current_version || "unknown"}.
              {info.update_available
                ? ` A newer version (${info.latest_version}) is ready.`
                : " You're on the latest Luna software."}
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
          </Card>
        )}
      </div>
    </Page>
  );
}
