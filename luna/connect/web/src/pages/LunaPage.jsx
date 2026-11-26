import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, Copy, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

import { api } from "../api.js";
import AccountPairingDetails from "../components/AccountPairingDetails.jsx";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { Input } from "../components/ui/input.jsx";
import ShakeTarget from "../components/ui/shake-target.jsx";
import { formatDeviceUid } from "../lib/devicePairing.js";
import { useAuth } from "../context/AuthContext.jsx";

const PUBLIC_ZONE = "luna.servers.libreloom.org";
const DEVICE_STATES = new Set(["unbound", "pairing", "bound", "revoked"]);

function subdomainOf(hostname) {
  const suffix = `.${PUBLIC_ZONE}`;
  return hostname && hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : "";
}

function ChangeAddressForm({ deviceId, hostname, onSaved, onCancel }) {
  const current = subdomainOf(hostname);
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmed = name.trim().toLowerCase();

  async function save(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api(`/api/v1/devices/${encodeURIComponent(deviceId)}/domain`, {
        method: "POST",
        body: JSON.stringify({ subdomain: trimmed }),
      });
      await onSaved(`${trimmed}.${PUBLIC_ZONE}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="rounded-large-element bg-muted border border-border px-4 py-4 space-y-3"
      data-testid="luna-change-address"
      onSubmit={save}
    >
      <label htmlFor="luna-address-name" className="block font-mono text-xs text-muted-foreground">
        New address
      </label>
      <ShakeTarget shake={error} loading={busy} className="space-y-2">
        <Input
          id="luna-address-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="kitchen"
          maxLength={32}
          autoFocus
          aria-invalid={error ? "true" : undefined}
          aria-describedby="luna-address-hint"
        />
        <p className="font-mono text-sm break-all">
          {trimmed ? `${trimmed}.${PUBLIC_ZONE}` : `kitchen.${PUBLIC_ZONE}`}
        </p>
      </ShakeTarget>
      <p id="luna-address-hint" className="text-sm leading-relaxed text-muted-foreground">
        Use 3 to 32 letters, numbers, or dashes. The old address stops working at once, and Luna moves to the new one within about 5 minutes.
      </p>
      {error && (
        <div className="rounded-large-element border border-error/30 bg-error/10 px-3 py-3 flex items-start gap-2" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-error" aria-hidden="true" />
          <p className="text-sm text-foreground">{error}</p>
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-2">
        <Button type="submit" loading={busy} disabled={trimmed.length < 3 || trimmed === current}>
          Change address
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Keep current address
        </Button>
      </div>
    </form>
  );
}

function DeviceStatusRow({ online, deviceUid, status }) {
  const uid = formatDeviceUid(deviceUid || "");
  const label = status === "pairing"
    ? "Pairing"
    : status === "revoked"
      ? "Reconnect required"
      : status === "bound"
        ? online
          ? "Online"
          : "Offline"
        : "Not paired";
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground"
      data-testid="luna-device-status"
    >
      <span
        className={`inline-flex items-center rounded-pill px-2.5 py-0.5 text-xs font-mono ${
          status === "bound" && online
            ? "bg-success/20 border border-success/30 text-success"
            : "bg-accent/20 border border-border text-muted-foreground"
        }`}
      >
        {label}
      </span>
      {uid ? (
        <span className="font-mono text-xs">
          Device ID <span className="text-foreground">{uid}</span>
        </span>
      ) : null}
    </div>
  );
}

function HostnameHero({ hostname, copied, onCopy }) {
  return (
    <div
      className="rounded-large-element bg-muted border border-border p-5 sm:p-6 text-foreground"
      data-testid="luna-hostname-hero"
    >
      <p className="font-mono text-xs text-muted-foreground mb-3">
        Public address
      </p>
      <div className="flex items-start gap-3">
        <a
          href={`https://${hostname}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xl sm:text-2xl break-all flex-1 min-w-0 text-foreground hover:underline motion-safe:transition-colors"
        >
          {hostname}
        </a>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={() => onCopy(hostname, "hostname")}
          aria-label="Copy address"
        >
          {copied === "hostname" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

function DeviceToolbar({ hostname, action, onChangeAddress }) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 pt-4 border-t border-border"
      data-testid="luna-device-toolbar"
    >
      {hostname ? (
        <Button variant="secondary" size="sm" asChild>
          <a href={`https://${hostname}`} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" />
            Open Luna
          </a>
        </Button>
      ) : null}
      {hostname ? (
        <Button variant="outline" size="sm" onClick={onChangeAddress}>
          Change address
        </Button>
      ) : null}
      {action ? (
        <Button
          variant={action.tone === "danger" ? "destructive" : "outline"}
          size="sm"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

export default function LunaPage() {
  const { me, refreshMe } = useAuth();
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoverPassword, setRecoverPassword] = useState("");
  const [copied, setCopied] = useState(null);
  const [changingAddress, setChangingAddress] = useState(false);
  const [addressNotice, setAddressNotice] = useState("");

  const load = useCallback(() => {
    return api("/api/v1/account/devices")
      .then((data) => {
        if (!Array.isArray(data?.devices)) {
          throw new Error("Luna Connect could not read this account's Lunas. Try again.");
        }
        setDevices(data.devices);
        setLoadError("");
      })
      .catch((err) => setLoadError(err.message));
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
    const t = setInterval(() => {
      load().catch(() => {});
    }, 30000);
    return () => clearInterval(t);
  }, [load]);

  const luna = devices[0] || null;
  const state = luna && DEVICE_STATES.has(luna.state) ? luna.state : null;
  const stateUnavailable = Boolean(luna && !state);
  const disconnectState = state === "pairing" || state === "bound" ? state : null;
  const publicHostname = state === "bound" ? (luna?.hostname || "") : "";
  const resumePath = me?.onboarding_path;
  const resumeStep = me?.onboarding_step;
  const setupPath = resumePath === "diy" ? "/diyonboarding" : "/onboarding";
  const needsResume = !loading && resumePath && resumeStep && resumeStep !== "done"
    && !publicHostname && state !== "pairing" && state !== "revoked" && !stateUnavailable;

  useEffect(() => {
    if (!disconnectState) setConfirmDisconnect(false);
    if (state !== "revoked") {
      setRecoverOpen(false);
      setRecoverPassword("");
    }
  }, [disconnectState, state]);

  function reload() {
    setLoading(true);
    return load().finally(() => setLoading(false));
  }

  async function disconnect() {
    if (!luna || !disconnectState) return;
    setError("");
    setDisconnecting(true);
    try {
      await api(`/api/v1/devices/${encodeURIComponent(luna.id)}`, { method: "DELETE" });
      setDevices([]);
      setConfirmDisconnect(false);
      setChangingAddress(false);
      setAddressNotice("");
      await refreshMe?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setDisconnecting(false);
    }
  }

  async function recover(event) {
    event.preventDefault();
    if (!luna || state !== "revoked" || !recoverPassword) return;
    setError("");
    setRecovering(true);
    try {
      const result = await api(`/api/v1/devices/${encodeURIComponent(luna.id)}/recover`, {
        method: "POST",
        body: JSON.stringify({ password: recoverPassword }),
        cache: "no-store",
      });
      if (!result?.pairing_id) {
        throw new Error("Luna Connect did not start recovery. Try again.");
      }
      setRecoverOpen(false);
      setRecoverPassword("");
      setAddressNotice("Reconnect started. Luna needs to finish pairing on your home network.");
      await load();
      await refreshMe?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setRecovering(false);
    }
  }

  async function copyText(text, target) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(target);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Could not copy. Select the text and copy it yourself.");
    }
  }

  const description = !luna
    ? "One Luna on this account. Pair it with its Device ID and Verification code, then Luna picks up its address when it comes online."
    : state === "pairing"
      ? "Luna is waiting to finish pairing."
      : state === "revoked"
        ? "Reconnect this Luna to use remote access and cloud backup again."
        : state === "bound"
          ? "This Luna is connected to your account."
          : "Luna Connect could not read this Luna's status.";

  const toolbarAction = recoverOpen || confirmDisconnect
    ? null
    : disconnectState
      ? {
          label: disconnectState === "pairing" ? "Cancel pairing" : "Disconnect",
          tone: disconnectState === "bound" ? "danger" : "default",
          onClick: () => {
            setError("");
            setConfirmDisconnect(true);
          },
        }
      : state === "revoked"
        ? {
            label: "Reconnect",
            tone: "default",
            onClick: () => {
              setError("");
              setRecoverPassword("");
              setRecoverOpen(true);
            },
          }
        : null;

  return (
    <Layout>
      <h1 className="font-mono text-3xl mb-2">Devices</h1>
      <p className="text-muted-foreground mb-8">Signed in as {me?.email}.</p>

      {needsResume && (
        <Card className="mb-6 animate-fade-in-up border-accent">
          <CardContent className="pt-6 flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
            <p className="text-sm leading-relaxed">
              You still have setup to finish.
            </p>
            <Button asChild>
              <Link to={setupPath}>Resume setup</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="animate-fade-in-up" data-testid="luna-device-card">
        <CardHeader>
          <CardTitle>My Luna</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading…</p>
          ) : loadError ? (
            <div className="rounded-large-element border border-error/30 bg-error/10 px-4 py-4 space-y-3" role="alert">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-error" aria-hidden="true" />
                <p className="text-sm text-foreground">{loadError}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={reload}>Try again</Button>
            </div>
          ) : !luna ? (
            <div className="rounded-large-element border border-dashed border-border px-6 py-10 text-center space-y-3">
              <p className="font-mono text-sm">No Luna paired yet.</p>
              <div className="flex flex-col sm:flex-row gap-2 justify-center">
                <Button asChild>
                  <Link to="/onboarding">Start setup</Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link to="/diyonboarding">I installed Luna myself</Link>
                </Button>
              </div>
            </div>
          ) : stateUnavailable ? (
            <div className="rounded-large-element border border-error/30 bg-error/10 px-4 py-4 space-y-3" role="alert" data-testid="luna-state-unavailable">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-error" aria-hidden="true" />
                <p className="text-sm text-foreground">Luna Connect could not read this Luna&apos;s status. Refresh and try again.</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={reload}>Try again</Button>
            </div>
          ) : (
            <div className="space-y-4">
              <DeviceStatusRow online={luna.online} deviceUid={luna.device_uid} status={state} />

              {publicHostname ? (
                <HostnameHero
                  hostname={publicHostname}
                  copied={copied}
                  onCopy={copyText}
                />
              ) : (
                <div
                  className="rounded-large-element border border-dashed border-border px-5 py-4"
                  data-testid="luna-hostname-pending"
                >
                  <p className="text-sm text-muted-foreground">
                    {state === "revoked"
                      ? "Reconnect this Luna before using remote access or cloud backup."
                      : state === "pairing"
                        ? "Waiting for Luna to finish pairing. Keep Luna on and connected to the internet."
                        : state === "bound"
                          ? "Paired, but no address yet."
                          : "This Luna is not paired to your account."}
                    {state === "bound" ? (
                      <>
                        {" "}<Link className="underline text-foreground" to={setupPath}>Finish setup</Link>
                      </>
                    ) : null}
                  </p>
                </div>
              )}

              {state === "pairing" || state === "bound" || state === "revoked" ? (
                <AccountPairingDetails key={luna.id} deviceId={luna.id} />
              ) : null}

              <DeviceToolbar
                hostname={publicHostname}
                action={toolbarAction}
                onChangeAddress={() => {
                  setAddressNotice("");
                  setChangingAddress(true);
                }}
              />

              {addressNotice && !changingAddress && (
                <p className="text-sm leading-relaxed text-foreground" role="status">
                  {addressNotice}
                </p>
              )}

              {changingAddress && publicHostname && (
                <ChangeAddressForm
                  deviceId={luna.id}
                  hostname={publicHostname}
                  onCancel={() => setChangingAddress(false)}
                  onSaved={async (newHostname) => {
                    await load();
                    setChangingAddress(false);
                    setAddressNotice(`Address changed to ${newHostname}. Luna moves to it within about 5 minutes.`);
                  }}
                />
              )}

              {confirmDisconnect && disconnectState && (
                <div
                  className="rounded-large-element bg-muted border border-border px-4 py-4 space-y-3"
                  data-testid="luna-disconnect-confirm"
                >
                  <p className="text-sm leading-relaxed text-foreground">
                    {disconnectState === "pairing"
                      ? "This cancels the pairing attempt. Luna keeps its Device ID and Verification code, and you can pair it again later."
                      : "This disconnects Luna from your account, and you can pair it again later with its Device ID and Verification code. Cloud backups stay on this account, and you keep paying for them until you turn off payment in Cloud backups."}
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button variant="destructive" loading={disconnecting} onClick={disconnect}>
                      {disconnectState === "pairing" ? "Cancel pairing" : "Disconnect"}
                    </Button>
                    <Button variant="outline" disabled={disconnecting} onClick={() => setConfirmDisconnect(false)}>
                      {disconnectState === "pairing" ? "Keep pairing" : "Keep this Luna"}
                    </Button>
                  </div>
                </div>
              )}

              {recoverOpen && state === "revoked" ? (
                <form
                  className="rounded-large-element bg-muted border border-border px-4 py-4 space-y-3"
                  data-testid="luna-recover-form"
                  onSubmit={recover}
                >
                  <p className="text-sm leading-relaxed text-foreground">
                    Enter your Luna Connect account password to start pairing again. If Luna&apos;s Verification code was removed, restore it in Settings → Luna Connect → Device token first.
                  </p>
                  <label htmlFor="luna-recover-password" className="block text-sm">
                    Luna Connect password
                  </label>
                  <Input
                    id="luna-recover-password"
                    type="password"
                    autoComplete="current-password"
                    value={recoverPassword}
                    onChange={(event) => setRecoverPassword(event.target.value)}
                    required
                    disabled={recovering}
                    autoFocus
                  />
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button type="submit" loading={recovering} disabled={!recoverPassword}>
                      Reconnect
                    </Button>
                    <Button type="button" variant="outline" disabled={recovering} onClick={() => {
                      setRecoverOpen(false);
                      setRecoverPassword("");
                      setError("");
                    }}>
                      Keep disconnected
                    </Button>
                  </div>
                </form>
              ) : null}
            </div>
          )}

          {error && (
            <div className="rounded-large-element border border-error/30 bg-error/10 px-3 py-3 flex items-start gap-2" role="alert">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-error" aria-hidden="true" />
              <p className="text-sm text-foreground">{error}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}
