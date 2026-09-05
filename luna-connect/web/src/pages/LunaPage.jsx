import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

import { api } from "../api.js";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { useAuth } from "../context/AuthContext.jsx";

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
          Device hint <span className="text-foreground">{codeHint}</span>
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
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-3">
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

function DeviceToolbar({ hostname, shownCode, confirmUnbind, onToggleCode, onUnbindClick }) {
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
      <Button variant="outline" size="sm" onClick={onToggleCode}>
        {shownCode ? "Hide code" : "Show code"}
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

  async function showCode() {
    if (!luna) return;
    setError("");
    try {
      const res = await api(`/api/v1/account/devices/${luna.id}/code`);
      setShownCode(res.code || res.code_hint || "");
      if (res.message && !res.code) setError(res.message);
    } catch (err) {
      setError(err.message);
    }
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
                    Linked, but no public name yet.{" "}
                    <Link className="underline text-foreground" to="/onboarding">
                      Finish setup
                    </Link>
                  </p>
                </div>
              )}

              <DeviceToolbar
                hostname={luna.hostname}
                shownCode={shownCode}
                confirmUnbind={confirmUnbind}
                onToggleCode={() => {
                  if (shownCode) {
                    setShownCode("");
                    setCopied(null);
                    return;
                  }
                  showCode();
                }}
                onUnbindClick={() => setConfirmUnbind(true)}
              />

              {confirmUnbind && (
                <div
                  className="rounded-large-element bg-muted border border-border px-4 py-4 space-y-3"
                  data-testid="luna-unbind-confirm"
                >
                  <p className="text-sm leading-relaxed">
                    The public address goes away. Cloud backups stay on this account and stay billed until you turn off payment in Cloud backups. Someone else can link this Luna later with the same device token.
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
              data-testid="luna-device-code"
            >
              <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                Device token
              </p>
              <p className="font-mono text-xl tracking-widest break-all">{shownCode}</p>
              <Button variant="secondary" onClick={() => copyText(shownCode, "code")}>
                <Copy className="h-4 w-4" />
                {copied === "code" ? "Copied" : "Copy code"}
              </Button>
            </div>
          )}

          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    </Layout>
  );
}
