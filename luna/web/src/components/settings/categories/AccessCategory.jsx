import { useState } from "react";
import PropTypes from "prop-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, Smartphone } from "lucide-react";
import Button from "../../ui/Button";
import CopyableValue from "../../ui/CopyableValue";
import SettingsCard from "../SettingsCard";
import SettingsRow from "../SettingsRow";
import PairingQrModal from "../PairingQrModal.jsx";
import { getJson, postJson, deleteJson, apiErrorMessage } from "../../../lib/api";
import PageNotice from "../../common/PageNotice";
import { showPageLevelError } from "../../../lib/modalScopedError";
import ShakeTarget from "../../ui/ShakeTarget";
import { useAnimatedHeight } from "../../../hooks/useAnimatedHeight";

function formatWhen(unix) {
  if (!unix) return "Never";
  return new Date(unix * 1000).toLocaleString();
}

/**
 * Token row with measured-height animation so Usage log expand/collapse
 * resizes smoothly (CSS cannot transition height: auto).
 */
function AccessTokenItem({ token, usageFor, usageRows, revokePending, onToggleUsage, onRevoke }) {
  const { outerRef, innerRef } = useAnimatedHeight();
  const expanded = usageFor === token.id;

  return (
    <li
      ref={outerRef}
      className="overflow-hidden rounded-large-element bg-primary text-secondary transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
      style={{ transitionDuration: "var(--motion-duration-medium2)" }}
    >
      <div ref={innerRef} className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-mono truncate">{token.name}</span>
          <div className="flex gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              surface="primary"
              onClick={onToggleUsage}
            >
              {expanded ? "Hide log" : "Usage log"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              surface="primary"
              loading={revokePending}
              onClick={onRevoke}
            >
              Revoke token
            </Button>
          </div>
        </div>
        <p className="text-xs">
          Last used: {formatWhen(token.last_used_at)}
          {token.expires_at ? ` · Expires ${formatWhen(token.expires_at)}` : ""}
        </p>
        {expanded && (
          <ul className="text-xs space-y-1 border-t border-secondary/30 pt-2">
            {usageRows.length === 0 && <li>No recent activity yet.</li>}
            {usageRows.map((row, i) => (
              <li key={`${row.used_at}-${i}`}>
                {row.action}{row.detail ? ` — ${row.detail}` : ""} · {formatWhen(row.used_at)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

AccessTokenItem.propTypes = {
  token: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    last_used_at: PropTypes.number,
    expires_at: PropTypes.number,
  }).isRequired,
  usageFor: PropTypes.string,
  usageRows: PropTypes.arrayOf(PropTypes.object).isRequired,
  revokePending: PropTypes.bool,
  onToggleUsage: PropTypes.func.isRequired,
  onRevoke: PropTypes.func.isRequired,
};

export default function AccessCategory() {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [tokenError, setTokenError] = useState(null);
  const [tokenName, setTokenName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [newToken, setNewToken] = useState(null);
  const [showQr, setShowQr] = useState(false);
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
      setShowQr(false);
      setTokenName("");
      setExpiresInDays("");
      setError(null);
      setTokenError(null);
    },
    onError: (err) => {
      const msg = apiErrorMessage(err);
      setError(msg);
      setTokenError(msg);
    },
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
      {showPageLevelError(error, showQr) && <PageNotice variant="error">{error}</PageNotice>}

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
          your password each time.
        </p>

        <div className="mt-4 flex flex-col gap-2">
          <p className="text-primary text-sm font-mono">Add a new access token</p>
          <label className="text-primary text-sm" htmlFor="token-name">
            Name this app so you can recognize it later
          </label>
          <ShakeTarget shake={tokenError}>
            <input
              id="token-name"
              className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
              placeholder="Kitchen Mac, photo backup, script"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
            />
          </ShakeTarget>
          <label className="text-primary text-sm" htmlFor="token-expiry">
            Optional: stop working after this many days (leave blank for no expiry)
          </label>
          <ShakeTarget shake={tokenError}>
            <input
              id="token-expiry"
              type="number"
              min="1"
              className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
              placeholder="e.g. 90"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
            />
          </ShakeTarget>
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
              Copy this now. Luna will not show it again. Paste it into Luna
              Desktop or the phone app, or show it as a QR code for the phone.
            </p>
            <CopyableValue
              value={newToken.token}
              copyLabel="Copy token"
              ariaLabel="Access token"
              surface="primary"
              multiline
            />
            <Button
              variant="outline"
              surface="primary"
              onClick={() => setShowQr(true)}
            >
              Show as QR code
            </Button>
            <PairingQrModal
              open={showQr}
              token={newToken.token}
              onClose={() => setShowQr(false)}
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
                <AccessTokenItem
                  key={t.id}
                  token={t}
                  usageFor={usageFor}
                  usageRows={usageFor === t.id ? (usage.data || []) : []}
                  revokePending={revokeOne.isPending}
                  onToggleUsage={() => setUsageFor(usageFor === t.id ? null : t.id)}
                  onRevoke={() => revokeOne.mutate(t.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
