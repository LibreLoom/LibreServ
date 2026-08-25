import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import Button from "../../ui/Button";
import SettingsCard from "../SettingsCard";
import SettingsRow from "../SettingsRow";
import { postJson, apiErrorMessage } from "../../../lib/api";
import PageNotice from "../../common/PageNotice";

export default function SignedInCategory() {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);

  const signOutBrowsers = useMutation({
    mutationFn: () => postJson("/api/v1/auth/revoke-sessions", {}),
    onSuccess: () => { window.location.href = "/login"; },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const stopBackups = useMutation({
    mutationFn: () => postJson("/api/v1/auth/revoke-devices", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["device-tokens"] });
      setError(null);
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  return (
    <SettingsCard icon={LogOut} title="Who is signed in" padding={false}>
      {error && <PageNotice variant="error" className="mx-4 mt-4 mb-2">{error}</PageNotice>}
      <p className="text-primary text-sm px-4 pb-2 pt-4">
        Signing out on this screen only leaves this browser. Use the
        buttons below if a phone, computer, or app should no longer reach your files.
      </p>
      <SettingsRow
        label="Sign out every browser"
        description="Use this if you signed in on a computer you don't trust anymore. Every browser must type the password again. Phone apps and access tokens keep working."
        stack
      >
        <Button variant="accent" loading={signOutBrowsers.isPending} onClick={() => signOutBrowsers.mutate()}>
          Sign out every browser
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Revoke app access"
        description="Use this if a phone or laptop was lost, or an app should no longer reach Luna. Those apps must sign in again. Browsers stay signed in."
        hideDivider
        stack
      >
        <Button variant="accent" loading={stopBackups.isPending} onClick={() => stopBackups.mutate()}>
          Revoke app access
        </Button>
      </SettingsRow>
    </SettingsCard>
  );
}
