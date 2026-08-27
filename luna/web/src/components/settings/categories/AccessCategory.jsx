import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, Smartphone } from "lucide-react";
import Button from "../../ui/Button";
import CopyableValue from "../../ui/CopyableValue";
import SettingsCard from "../SettingsCard";
import SettingsRow from "../SettingsRow";
import { getJson, postJson, deleteJson, apiErrorMessage } from "../../../lib/api";
import PageNotice from "../../common/PageNotice";

function formatWhen(unix) {
  if (!unix) return "Never";
  return new Date(unix * 1000).toLocaleString();
}

export default function AccessCategory() {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [tokenName, setTokenName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [newToken, setNewToken] = useState(null);
  const [usageFor, setUsageFor] = useState(null);

  const tokens = useQuery({
    queryKey: ["device-tokens"],
    queryFn: () => getJson("/api/v1/device-tokens"),
  });
  const usage = useQuery({
    queryKey: ["device-token-usage", usageFor],
    queryFn: () => getJson(`/api/v1/device-tokens/${usageFor}/usage`),
    enabled: Boolean(usageFor),
  });

  const signOutBrowsers = useMutation({
    mutationFn: () => postJson("/api/v1/auth/revoke-sessions", {}),
    onSuccess: () => { window.location.href = "/login"; },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const createToken = useMutation({
    mutationFn: () => postJson("/api/v1/device-tokens", {
      name: tokenName.trim(),
      expires_in_days: expiresInDays ? Number(expiresInDays) : undefined,
    }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["device-tokens"] });
      setNewToken(data);
      setTokenName("");
      setExpiresInDays("");
      setError(null);
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const revokeOne = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/device-tokens/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["device-tokens"] });
      setUsageFor(null);
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const tokenList = tokens.data || [];

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

        <div className="mt-4 flex flex-col gap-2">
          <p className="text-primary text-sm font-mono">Add a new access token</p>
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
          <label className="text-primary text-sm" htmlFor="token-expiry">
            Optional: stop working after this many days (leave blank for no expiry)
          </label>
          <input
            id="token-expiry"
            type="number"
            min="1"
            className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
            placeholder="e.g. 90"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
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
          <div className="mt-4 rounded-large-element bg-primary text-secondary p-4 space-y-3">
            <p className="text-sm">
              Copy this now. Luna will not show it again. Use it as the password when a computer
              asks to open your files as a folder.
            </p>
            <CopyableValue
              value={newToken.token}
              copyLabel="Copy token"
              ariaLabel="Access token"
              surface="primary"
              multiline
            />
          </div>
        )}

        <div className="mt-6 space-y-2">
          <p className="text-primary text-sm font-mono">Your access tokens</p>
          {tokenList.length === 0 ? (
            <p className="text-primary text-sm">No apps or access tokens are set up yet.</p>
          ) : (
            <ul className="space-y-2">
              {tokenList.map((t) => (
                <li key={t.id} className="rounded-large-element bg-primary text-secondary p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-mono truncate">{t.name}</span>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        surface="primary"
                        onClick={() => setUsageFor(usageFor === t.id ? null : t.id)}
                      >
                        {usageFor === t.id ? "Hide log" : "Usage log"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        surface="primary"
                        loading={revokeOne.isPending}
                        onClick={() => revokeOne.mutate(t.id)}
                      >
                        Revoke token
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs">
                    Last used: {formatWhen(t.last_used_at)}
                    {t.expires_at ? ` · Expires ${formatWhen(t.expires_at)}` : ""}
                  </p>
                  {usageFor === t.id && (
                    <ul className="text-xs space-y-1 border-t border-secondary/30 pt-2">
                      {(usage.data || []).length === 0 && <li>No recent activity yet.</li>}
                      {(usage.data || []).map((row, i) => (
                        <li key={`${row.used_at}-${i}`}>
                          {row.action}{row.detail ? ` — ${row.detail}` : ""} · {formatWhen(row.used_at)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
