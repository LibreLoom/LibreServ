import { useState } from "react";
import PropTypes from "prop-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, History, Shield, Smartphone, Trash2, User, UserRound } from "lucide-react";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { ActionTooltipGroup, InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import CopyableValue from "@libreloom/ui/components/ui/CopyableValue.jsx";
import PasswordStrengthChecklist from "@libreloom/ui/components/common/PasswordStrengthChecklist.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import SettingsRow from "@libreloom/ui/components/settings/SettingsRow.jsx";
import PairingQrModal from "../PairingQrModal.jsx";
import FormInput from "../../common/forms/FormInput";
import { getJson, postJson, deleteJson, patchJson, apiErrorMessage } from "../../../lib/api";
import { meetsPasswordPolicy, passwordPolicyError } from "@libreloom/ui/lib/passwordPolicy.js";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import { useAnimatedHeight } from "@libreloom/ui/hooks/useAnimatedHeight.jsx";
import useStrandedErrorToast from "../../../hooks/useStrandedErrorToast";
import { useOptionalAuth } from "../../../context/AuthContext";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";

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

/**
 * The signed-in person's own profile: the name everyone sees, and the
 * password that signs them in. A password change signs out every session —
 * this browser included — so the save lands on the login screen.
 */
function ProfileCard() {
  // Optional: unit surfaces render this card without an auth tree.
  const { user, refresh } = useOptionalAuth() || {};
  const { addToast } = useToast();
  const [name, setName] = useState(user?.display_name || "");
  const [nameError, setNameError] = useState(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState(null);

  const nameClean = name.trim();
  const nameDirty = nameClean !== (user?.display_name || "");
  const passwordProblem = newPassword && !meetsPasswordPolicy(newPassword)
    ? passwordPolicyError(newPassword) || "Choose a stronger password."
    : null;

  const saveName = useMutation({
    mutationFn: () => patchJson("/api/v1/auth/me", { display_name: nameClean }),
    onSuccess: async () => {
      addToast({ type: "success", message: "Name saved." });
      setNameError(null);
      await refresh?.();
    },
    onError: (err) => setNameError(apiErrorMessage(err, "Couldn't save your name. Try again.")),
  });

  const changePassword = useMutation({
    mutationFn: () => patchJson("/api/v1/auth/me", {
      current_password: currentPassword,
      new_password: newPassword,
    }),
    onSuccess: () => {
      addToast({ type: "success", message: "Password changed. Sign in again with your new password." });
      window.location.href = "/login";
    },
    onError: (err) => setPasswordError(apiErrorMessage(err, "Couldn't change your password. Try again.")),
  });

  const isAdmin = user?.role === "admin";

  return (
    <SettingsCard icon={UserRound} title="You" index={-1}>
      {user && (
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-full bg-primary text-secondary flex items-center justify-center flex-shrink-0">
            <User size={ICON_SIZE.xl} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-primary truncate">
              {user.display_name || user.username}
            </p>
            {user.display_name && user.username !== user.display_name && (
              <p className="text-sm text-accent truncate">
                Signed in as {user.username}
              </p>
            )}
          </div>
          <span className="inline-flex items-center gap-1 rounded-pill bg-primary/10 px-2.5 py-1 text-xs text-primary shrink-0">
            <Shield size={ICON_SIZE.xs} aria-hidden="true" />
            {isAdmin ? "Admin" : "Member"}
            <InfoHint
              label={isAdmin ? "What Admin means" : "What Member means"}
              content={
                isAdmin
                  ? "An Admin can add users, change settings, and manage everything on this Luna."
                  : "A Member can use what's shared with them but cannot manage users or change this Luna's settings."
              }
            />
          </span>
        </div>
      )}

      <div className="mt-4 rounded-large-element bg-primary text-secondary p-4">
        <p className="font-mono text-sm">Your name</p>
        <p className="text-sm mt-1">
          The name other people see when you share or get shared with.
        </p>
        <div className="mt-2 sm:flex">
          <div className="flex-1 min-w-0">
            <FormInput
              label="Name"
              name="profile-name"
              surface="primary"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              autoComplete="name"
              error={nameError}
              required
            />
          </div>
          {/* Stretch across the input's height, centered on the pill:
              mt-5.5 clears the 24px label row (20px line + FormInput's
              mb-1) minus the input's 2px top border; mb-3.5 mirrors
              FormInput's mb-4 minus the bottom border. The borderless
              button ends up 4px taller so it reads the same size as the
              outlined input pill. */}
          <Button
            variant="secondary"
            surface="primary"
            className="shrink-0 sm:ml-2 sm:mt-5.5 sm:mb-3.5"
            loading={saveName.isPending}
            disabled={!nameClean || !nameDirty}
            onClick={() => saveName.mutate()}
          >
            Save name
          </Button>
        </div>
      </div>

      <div className="mt-3 rounded-large-element bg-primary text-secondary p-4">
        <p className="font-mono text-sm">Password</p>
        <p className="text-sm mt-1">
          Changing your password signs out every browser and app — including
          this one — so sign in again afterward.
        </p>
        <div className="mt-2 sm:grid sm:grid-cols-2 sm:gap-x-3">
          <FormInput
            label="Current password"
            name="profile-current-password"
            type="password"
            icon="password"
            surface="primary"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              setPasswordError(null);
            }}
            autoComplete="current-password"
          />
          <FormInput
            label="New password"
            name="profile-new-password"
            type="password"
            icon="password"
            surface="primary"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setPasswordError(null);
            }}
            autoComplete="new-password"
            error={passwordError}
          />
        </div>
        {newPassword ? (
          <PasswordStrengthChecklist password={newPassword} surface="primary" />
        ) : null}
        <Button
          variant="secondary"
          surface="primary"
          loading={changePassword.isPending}
          disabled={!currentPassword || !newPassword || Boolean(passwordProblem)}
          onClick={() => changePassword.mutate()}
        >
          Change password
        </Button>
      </div>
    </SettingsCard>
  );
}

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

      <ProfileCard />

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
