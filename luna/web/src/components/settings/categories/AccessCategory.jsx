import { useState } from "react";
import PropTypes from "prop-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, History, Smartphone, Trash2 } from "lucide-react";
import { ICON_SIZE } from "../../../lib/ui-tokens";
import Button from "../../ui/Button";
import { ActionTooltipGroup } from "../../ui/Tooltip.jsx";
import CopyableValue from "../../ui/CopyableValue";
import SettingsCard from "../SettingsCard";
import SettingsRow from "../SettingsRow";
import PairingQrModal from "../PairingQrModal.jsx";
import { getJson, postJson, deleteJson, apiErrorMessage } from "../../../lib/api";
import PageNotice from "../../common/PageNotice";
import ShakeTarget from "../../ui/ShakeTarget";
import { useAnimatedHeight } from "../../../hooks/useAnimatedHeight";
import useStrandedErrorToast from "../../../hooks/useStrandedErrorToast";
import { useToast } from "../../../context/ToastContext";

function formatWhen(unix) {
  if (!unix) return "Never";
  return new Date(unix * 1000).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

/**
 * Token row with measured-height animation so Usage log expand/collapse
 * resizes smoothly (CSS cannot transition height: auto).
 */
function AccessTokenItem({ token, nowUnix, usageFor, usageRows, usagePending, revokePending, onToggleUsage, onRevoke }) {
  const { outerRef, innerRef } = useAnimatedHeight();
  const expanded = usageFor === token.id;
  const expired = token.expires_at != null && token.expires_at <= nowUnix;

  return (
    <li
      ref={outerRef}
      className="overflow-hidden transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
      style={{ transitionDuration: "var(--motion-duration-medium2)" }}
    >
      <div ref={innerRef}>
        <div className="flex items-center gap-2 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-mono truncate">{token.name}</p>
            <p className="text-xs text-accent">
              {token.last_used_at ? `Last used ${formatWhen(token.last_used_at)}` : "Never used"}
              {token.expires_at != null && (
                expired ? (
                  <>
                    {" · "}
                    <span className="text-warning">Expired {formatWhen(token.expires_at)}</span>
                  </>
                ) : (
                  ` · Expires ${formatWhen(token.expires_at)}`
                )
              )}
            </p>
          </div>
          <ActionTooltipGroup className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              surface="primary"
              className={expanded ? "bg-secondary/10" : ""}
              tooltip={expanded ? "Hide usage log" : "Usage log"}
              aria-label={`${expanded ? "Hide" : "Show"} usage log for ${token.name || "this token"}`}
              aria-expanded={expanded}
              onClick={onToggleUsage}
            >
              <History size={ICON_SIZE.md} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              surface="primary"
              loading={revokePending}
              tooltip="Revoke token"
              aria-label={token.name ? `Revoke token ${token.name}` : "Revoke token"}
              onClick={onRevoke}
            >
              <Trash2 size={ICON_SIZE.md} aria-hidden="true" />
            </Button>
          </ActionTooltipGroup>
        </div>
        {expanded && (
          <div className="px-3 pb-3 pt-1">
            <ul className="rounded-large-element bg-secondary/5 px-3 py-2.5 text-xs space-y-2">
              {usagePending ? (
                <li>Checking recent activity…</li>
              ) : usageRows.length === 0 ? (
                <li>No recent activity yet.</li>
              ) : (
                usageRows.map((row, i) => {
                  const label = row.action === "auth" && row.detail === "api"
                    ? "API access"
                    : `${row.action}${row.detail ? ` — ${row.detail}` : ""}`;

                  return (
                    <li key={`${row.used_at}-${i}`} className="flex flex-col gap-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono truncate">{label}</span>
                        <span className="text-accent text-[11px] shrink-0">{formatWhen(row.used_at)}</span>
                      </div>
                      {row.client || row.origin ? (
                        <div className="text-accent text-[11px] flex items-center gap-1.5 truncate">
                          {row.client && <span>{row.client}</span>}
                          {row.client && row.origin && <span>·</span>}
                          {row.origin && <span>{row.origin}</span>}
                        </div>
                      ) : (
                        <div className="text-accent text-[11px] truncate">
                          Older activity before detailed logging
                        </div>
                      )}
                    </li>
                  );
                })
              )}
            </ul>
          </div>
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
  nowUnix: PropTypes.number.isRequired,
  usageFor: PropTypes.string,
  usageRows: PropTypes.arrayOf(PropTypes.object).isRequired,
  usagePending: PropTypes.bool,
  revokePending: PropTypes.bool,
  onToggleUsage: PropTypes.func.isRequired,
  onRevoke: PropTypes.func.isRequired,
};

export default function AccessCategory() {
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [tokenError, setTokenError] = useState(null);
  const [tokenName, setTokenName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [newToken, setNewToken] = useState(null);
  const [showQr, setShowQr] = useState(false);
  const [usageFor, setUsageFor] = useState(null);
  const [nowUnix] = useState(() => Math.floor(Date.now() / 1000));

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
      addToast({ type: "success", message: "Token created." });
      queryClient.invalidateQueries({ queryKey: ["device-tokens"] });
      setNewToken(data);
      setShowQr(false);
      setTokenName("");
      setExpiresInDays("");
      setError(null);
      setTokenError(null);
    },
    onError: (err) => {
      // The create form is open — it owns this error; don't strand it.
      setTokenError(apiErrorMessage(err));
    },
  });

  const revokeOne = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/device-tokens/${id}`),
    onSuccess: () => {
      addToast({ type: "success", message: "Token revoked." });
      queryClient.invalidateQueries({ queryKey: ["device-tokens"] });
      setUsageFor(null);
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  useStrandedErrorToast(error, showQr, () => setError(null));

  const tokenList = tokens.data || [];

  return (
    <div className="space-y-4">

      <SettingsCard icon={Globe2} title="Browsers" padding={false} index={0}>
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
          A phone app, Luna Desktop, or script can keep working without typing
          your password each time.
        </p>

        <div className="mt-4 flex flex-col gap-2">
          <p className="text-primary text-sm font-mono">Add a new access token</p>
          <label className="text-primary text-sm translate-x-5" htmlFor="token-name">
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
          <label className="text-primary text-sm translate-x-5" htmlFor="token-expiry">
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
          {tokenError && <PageNotice variant="error">{tokenError}</PageNotice>}
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
            <div className="overflow-hidden rounded-large-element bg-primary text-secondary">
              <ul className="divide-y divide-secondary/10">
                {tokenList.map((t) => (
                  <AccessTokenItem
                    key={t.id}
                    token={t}
                    nowUnix={nowUnix}
                    usageFor={usageFor}
                    usageRows={usageFor === t.id ? (usage.data || []) : []}
                    usagePending={usageFor === t.id && usage.isPending}
                    revokePending={revokeOne.isPending && revokeOne.variables === t.id}
                    onToggleUsage={() => setUsageFor(usageFor === t.id ? null : t.id)}
                    onRevoke={() => revokeOne.mutate(t.id)}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
