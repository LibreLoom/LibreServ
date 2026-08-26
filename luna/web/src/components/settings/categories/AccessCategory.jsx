import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, Smartphone } from "lucide-react";
import Button from "../../ui/Button";
import SettingsCard from "../SettingsCard";
import SettingsRow from "../SettingsRow";
import { getJson, postJson, deleteJson, apiErrorMessage } from "../../../lib/api";
import PageNotice from "../../common/PageNotice";

export default function AccessCategory() {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [tokenName, setTokenName] = useState("");
  const [newToken, setNewToken] = useState(null);
  const [copiedToken, setCopiedToken] = useState(false);

  const tokens = useQuery({
    queryKey: ["device-tokens"],
    queryFn: () => getJson("/api/v1/device-tokens"),
  });

  const signOutBrowsers = useMutation({
    mutationFn: () => postJson("/api/v1/auth/revoke-sessions", {}),
    onSuccess: () => { window.location.href = "/login"; },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const createToken = useMutation({
    mutationFn: () => postJson("/api/v1/device-tokens", { name: tokenName.trim() }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["device-tokens"] });
      setNewToken(data);
      setTokenName("");
      setError(null);
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const revokeOne = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/device-tokens/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["device-tokens"] }),
    onError: (err) => setError(apiErrorMessage(err)),
  });

  return (
    <div className="space-y-4">
      {error && <PageNotice variant="error">{error}</PageNotice>}

      <SettingsCard icon={Globe2} title="Browsers" padding={false} index={0}>
        <p className="text-primary text-sm px-4 pb-2 pt-4">
          Luna keeps you signed in on each browser you use. Luna cannot show a
          list of every browser — use the button below to sign out everywhere at
          once.
        </p>
        <SettingsRow
          label="Sign out every browser"
          description="Every browser must type the password again. Apps and access tokens below keep working."
          hideDivider
          stack
        >
          <Button
            variant="accent"
            loading={signOutBrowsers.isPending}
            onClick={() => signOutBrowsers.mutate()}
          >
            Sign out every browser
          </Button>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard icon={Smartphone} title="Apps and access tokens" index={1}>
        <p className="text-primary text-sm">
          A phone app, desktop app, or script can keep working without typing
          your password each time. Folder mounts (Finder, Explorer) use this access
          token as the password — never your Luna password. Only an admin can mount the
          whole drive as a folder.
        </p>
        <ul className="mt-3 space-y-2">
          {(tokens.data || []).map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2">
              <span className="text-primary text-sm font-mono truncate">{t.name}</span>
              <Button size="sm" variant="outline" loading={revokeOne.isPending} onClick={() => revokeOne.mutate(t.id)}>
                Stop this app
              </Button>
            </li>
          ))}
        </ul>
        {(tokens.data || []).length === 0 && (
          <p className="text-primary text-sm mt-2">No apps or access tokens are set up yet.</p>
        )}
        <div className="mt-4 flex flex-col gap-2">
          <label className="text-primary text-sm" htmlFor="token-name">
            Name this app so you can recognize it later
          </label>
          <input
            id="token-name"
            className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
            placeholder="Kitchen Mac, photo backup, script"
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
          />
          <Button
            variant="primary"
            loading={createToken.isPending}
            disabled={!tokenName.trim()}
            onClick={() => createToken.mutate()}
          >
            Create access token
          </Button>
        </div>
        {newToken?.token && (
          <div className="mt-4 rounded-large-element bg-primary text-secondary p-4">
            <p className="text-sm">
              Copy this now. Luna will not show it again. Use it as the password when a computer
              asks to open your files as a folder.
            </p>
            <p className="mt-2 text-sm font-mono break-all">{newToken.token}</p>
            <Button
              size="sm"
              variant="primary"
              className="mt-3"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(newToken.token);
                  setCopiedToken(true);
                } catch {
                  setCopiedToken(false);
                }
              }}
            >
              {copiedToken ? "Copied" : "Copy token"}
            </Button>
          </div>
        )}
      </SettingsCard>
    </div>
  );
}
