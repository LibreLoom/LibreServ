import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Keyboard, Smartphone, LogOut, Palette, FolderOpen } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import Pill from "../components/common/Pill";
import PageNotice from "../components/common/PageNotice";
import WifiCard from "../components/settings/WifiCard";
import { getJson, postJson, apiErrorMessage } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { useHapticsEnabled, setHapticsEnabled } from "../utils/haptics";

/* eslint-disable react-refresh/only-export-components -- recovery copy is shared with tests */

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
  const { theme, setTheme } = useTheme();
  const hapticsOn = useHapticsEnabled();
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [tokenName, setTokenName] = useState("");
  const [newToken, setNewToken] = useState(null);
  const [copiedToken, setCopiedToken] = useState(false);
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
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const apply = useMutation({
    mutationFn: () => postJson("/api/v1/system/updates/apply", {}),
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const tokens = useQuery({
    queryKey: ["device-tokens"],
    queryFn: () => getJson("/api/v1/device-tokens"),
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
  const signOutBrowsers = useMutation({
    mutationFn: () => postJson("/api/v1/auth/revoke-sessions", {}),
    onSuccess: () => { window.location.href = "/login"; },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const stopBackups = useMutation({
    mutationFn: () => postJson("/api/v1/auth/revoke-devices", {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["device-tokens"] }); setError(null); setNewToken(null); },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const revokeOne = useMutation({
    mutationFn: async (id) => {
      const res = await fetch(`/api/v1/device-tokens/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Couldn't stop this app");
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["device-tokens"] }),
    onError: (err) => setError(apiErrorMessage(err)),
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
        <Card icon={Palette} title="Look and feel">
          <p className="text-primary text-sm">
            Light, dark, or match this device. Vibration on taps is optional.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {[
              { value: "system", label: "Match device" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ].map((opt) => (
              <Button
                key={opt.value}
                size="sm"
                variant={theme === opt.value ? "primary" : "outline"}
                onClick={() => setTheme(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          <div className="mt-4">
            <Button
              size="sm"
              variant={hapticsOn ? "primary" : "outline"}
              onClick={() => setHapticsEnabled(!hapticsOn)}
            >
              {hapticsOn ? "Vibration on" : "Vibration off"}
            </Button>
          </div>
        </Card>

        {user?.role === "admin" && <WifiCard />}

        <Card icon={FolderOpen} title="Phones and computers">
          <p className="text-primary text-sm">
            Phone photos: install the Luna app from the same place you downloaded
            Luna, sign in with your household username, and turn photo backup on.
            Photos save on Wi-Fi while the phone charges, into a folder named Phone Backup.
          </p>
          <p className="text-primary text-sm mt-3">
            Computers: use the Luna Desktop app, or open a drive as a folder with
            the steps on the Files page. Create an access token below first — that
            is the password Finder or Explorer will ask for.
          </p>
        </Card>
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

        <Card icon={LogOut} title="Who is signed in">
          <p className="text-primary text-sm">
            Signing out on this screen only leaves this browser. Use the
            buttons below if a phone, computer, or helper&apos;s tool should no longer reach your files.
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <div>
              <Button variant="accent" loading={signOutBrowsers.isPending} onClick={() => signOutBrowsers.mutate()}>
                Sign out every browser
              </Button>
              <p className="text-primary text-xs mt-2">
                Use this if you signed in on a computer you don&apos;t trust anymore. Every
                browser must type the password again. Phone apps and helper tools keep working.
              </p>
            </div>
            <div>
              <Button variant="accent" loading={stopBackups.isPending} onClick={() => stopBackups.mutate()}>
                Stop apps and helper tools
              </Button>
              <p className="text-primary text-xs mt-2">
                Use this if a phone or laptop was lost, or a helper should no longer reach Luna.
                Those apps must sign in again. Browsers stay signed in.
              </p>
            </div>
          </div>
        </Card>

        <Card icon={Smartphone} title="Apps and helper tools">
          <p className="text-primary text-sm">
            A computer or phone app, or a tool a helper set up, can keep working without typing
            your household password each time. Folder mounts (Finder, Explorer) use this access
            token as the password — never the household password. Only an admin can mount the
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
            <p className="text-primary text-sm mt-2">No apps or helper tools are set up yet.</p>
          )}
          <div className="mt-4 flex flex-col gap-2">
            <label className="text-primary text-sm" htmlFor="token-name">
              Name this app so you can recognize it later
            </label>
            <input
              id="token-name"
              className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
              placeholder="Kitchen Mac, photo backup, helper script"
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
