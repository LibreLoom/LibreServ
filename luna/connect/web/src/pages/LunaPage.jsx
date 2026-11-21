import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

import { api } from "../api.js";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { Input } from "../components/ui/input.jsx";
import ShakeTarget from "../components/ui/shake-target.jsx";
import { useAuth } from "../context/AuthContext.jsx";

const PUBLIC_ZONE = "luna.servers.libreloom.org";

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
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
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

function RevealTokenForm({ deviceId, onRevealed, onCancel }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function reveal(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await api(`/api/v1/account/devices/${encodeURIComponent(deviceId)}/code`, {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      onRevealed(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="rounded-large-element bg-muted border border-border px-4 py-4 space-y-3"
      data-testid="luna-reveal-token"
      onSubmit={reveal}
    >
      <label htmlFor="luna-reveal-password" className="block font-mono text-xs text-muted-foreground">
        Your Luna Connect password
      </label>
      <ShakeTarget shake={error} loading={busy}>
        <Input
          id="luna-reveal-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          aria-invalid={error ? "true" : undefined}
          aria-describedby="luna-reveal-hint"
        />
      </ShakeTarget>
      <p id="luna-reveal-hint" className="text-sm leading-relaxed text-muted-foreground">
        Anyone with the device token can take over this Luna's public address, so we check your password first.
      </p>
      {error && (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-col sm:flex-row gap-2">
        <Button type="submit" loading={busy} disabled={!password}>
          Show token
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DeviceStatusRow({ online, codeHint }) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground"
      data-testid="luna-device-status"
    >
      <span
        className={`inline-flex items-center rounded-pill px-2.5 py-0.5 text-xs font-mono ${
          online
            ? "bg-success/20 border border-success/30 text-success"
            : "bg-accent/20 border border-border text-muted-foreground"
        }`}
      >
        {online ? "Online" : "Offline"}
      </span>
      {codeHint ? (
        <span className="font-mono text-xs">
          Device token <span className="text-foreground">{codeHint}</span>
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

function DeviceToolbar({ hostname, shownCode, confirmUnbind, onToggleCode, onUnbindClick, onChangeAddress }) {
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
      <Button variant="outline" size="sm" onClick={onToggleCode}>
        {shownCode ? "Hide token" : "Show token"}
      </Button>
      {!confirmUnbind ? (
        <Button variant="outline" size="sm" onClick={onUnbindClick}>
          Unbind Luna
        </Button>
      ) : null}
    </div>
  );
}

export default function LunaPage() {
  const { me, refreshMe } = useAuth();
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [shownCode, setShownCode] = useState("");
  const [unbinding, setUnbinding] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [copied, setCopied] = useState(null);
  const [changingAddress, setChangingAddress] = useState(false);
  const [addressNotice, setAddressNotice] = useState("");
  const [tokenNotice, setTokenNotice] = useState("");
  const [revealing, setRevealing] = useState(false);

  const load = useCallback(() => {
    return api("/api/v1/account/devices")
      .then((d) => setDevices(d.devices || []))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
    const t = setInterval(() => {
      load().catch(() => {});
    }, 30000);
    return () => clearInterval(t);
  }, [load]);

  const luna = devices[0] || null;
  const resumePath = me?.onboarding_path;
  const resumeStep = me?.onboarding_step;
  const needsResume = resumePath && resumeStep && resumeStep !== "done" && !luna?.hostname;

  function onRevealed(res) {
    setRevealing(false);
    setShownCode(res.code || "");
    setTokenNotice(
      res.code ? "" : res.message || "The full device token is on the card that came with Luna.",
    );
  }

  async function unbind() {
    if (!luna) return;
    setError("");
    setUnbinding(true);
    try {
      await api(`/api/v1/devices/${luna.id}`, { method: "DELETE" });
      setDevices([]);
      setConfirmUnbind(false);
      setShownCode("");
      await refreshMe?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setUnbinding(false);
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
              <Link to={resumePath === "diy" ? "/diyonboarding" : "/onboarding"}>Resume setup</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="animate-fade-in-up" data-testid="luna-device-card">
        <CardHeader>
          <CardTitle>My Luna</CardTitle>
          <CardDescription>
            One Luna on this account. Link it with your device token, then Luna picks up its address when it comes online.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading…</p>
          ) : !luna ? (
            <div className="rounded-large-element border border-dashed border-border px-6 py-10 text-center space-y-3">
              <p className="font-mono text-sm">No Luna linked yet.</p>
              <div className="flex flex-col sm:flex-row gap-2 justify-center">
                <Button asChild>
                  <Link to="/onboarding">Start setup</Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link to="/diyonboarding">I installed Luna myself</Link>
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <DeviceStatusRow online={luna.online} codeHint={luna.code_hint} />

              {luna.hostname ? (
                <HostnameHero
                  hostname={luna.hostname}
                  copied={copied}
                  onCopy={copyText}
                />
              ) : (
                <div
                  className="rounded-large-element border border-dashed border-border px-5 py-4"
                  data-testid="luna-hostname-pending"
                >
                  <p className="text-sm text-muted-foreground">
                    Linked, but no address yet.{" "}
                    <Link className="underline text-foreground" to="/onboarding">
                      Finish setup
                    </Link>
                  </p>
                </div>
              )}

              <DeviceToolbar
                hostname={luna.hostname}
                shownCode={shownCode || tokenNotice}
                confirmUnbind={confirmUnbind}
                onToggleCode={() => {
                  if (shownCode || tokenNotice) {
                    setShownCode("");
                    setTokenNotice("");
                    setCopied(null);
                    return;
                  }
                  setError("");
                  setRevealing((open) => !open);
                }}
                onUnbindClick={() => setConfirmUnbind(true)}
                onChangeAddress={() => {
                  setAddressNotice("");
                  setChangingAddress(true);
                }}
              />

              {revealing && !shownCode && !tokenNotice && (
                <RevealTokenForm
                  deviceId={luna.id}
                  onRevealed={onRevealed}
                  onCancel={() => setRevealing(false)}
                />
              )}

              {addressNotice && !changingAddress && (
                <p className="text-sm leading-relaxed" role="status">
                  {addressNotice}
                </p>
              )}

              {changingAddress && luna.hostname && (
                <ChangeAddressForm
                  deviceId={luna.id}
                  hostname={luna.hostname}
                  onCancel={() => setChangingAddress(false)}
                  onSaved={async (newHostname) => {
                    await load();
                    setChangingAddress(false);
                    setAddressNotice(`Address changed to ${newHostname}. Luna moves to it within about 5 minutes.`);
                  }}
                />
              )}

              {confirmUnbind && (
                <div
                  className="rounded-large-element bg-muted border border-border px-4 py-4 space-y-3"
                  data-testid="luna-unbind-confirm"
                >
                  <p className="text-sm leading-relaxed">
                    The public address stops working. Cloud backups stay on this account, and you pay for them until you turn off payment in Cloud backups. Anyone with this device token can link this Luna again later.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button variant="destructive" loading={unbinding} onClick={unbind}>
                      Unbind Luna
                    </Button>
                    <Button variant="outline" onClick={() => setConfirmUnbind(false)}>
                      Keep this Luna
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {shownCode && (
            <div
              className="rounded-large-element bg-muted border border-border px-5 py-4 space-y-3"
              data-testid="luna-device-token"
            >
              <p className="font-mono text-xs text-muted-foreground">
                Device token
              </p>
              <p className="font-mono text-xl tracking-widest break-all">{shownCode}</p>
              <Button variant="secondary" onClick={() => copyText(shownCode, "token")}>
                <Copy className="h-4 w-4" />
                {copied === "token" ? "Copied" : "Copy token"}
              </Button>
            </div>
          )}

          {tokenNotice && (
            <p className="text-sm leading-relaxed" role="status">
              {tokenNotice}
            </p>
          )}

          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    </Layout>
  );
}
