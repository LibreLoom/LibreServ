import { useCallback, useEffect, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

import { api } from "../api.js";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { useAuth } from "../context/AuthContext.jsx";

export default function LunaPage() {
  const { me, refreshMe } = useAuth();
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [shownCode, setShownCode] = useState("");
  const [unbinding, setUnbinding] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [copied, setCopied] = useState(false);

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

  async function copyCode(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy. Select the text and copy it yourself.");
    }
  }

  return (
    <Layout>
      <h1 className="font-mono text-3xl mb-2">Away from home</h1>
      <p className="text-muted-foreground mb-8">Signed in as {me?.email}.</p>

      {needsResume && (
        <Card className="mb-6 animate-fade-in-up border-accent">
          <CardContent className="pt-6 flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
            <p className="text-sm leading-relaxed">
              You still have setup to finish ({resumePath === "diy" ? "bring your own" : "official"}).
            </p>
            <Button asChild>
              <Link to={resumePath === "diy" ? "/diyonboarding" : "/onboarding"}>Resume setup</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="animate-fade-in-up">
        <CardHeader>
          <CardTitle>My Luna</CardTitle>
          <CardDescription>
            One Luna on this account. Bind with the device code, then Luna picks up the address when it is online.
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
                  <Link to="/diyonboarding">I set this computer up myself</Link>
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-large-element border border-border px-4 py-3 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-pill px-3 py-1 text-xs font-mono ${
                      luna.online
                        ? "bg-success/20 border border-success/30 text-success"
                        : "bg-accent/20 border border-border text-muted-foreground"
                    }`}
                  >
                    {luna.online ? "Online" : "Offline"}
                  </span>
                  <span className="font-mono text-sm">{luna.code_hint || "••••"}</span>
                </div>
                {luna.hostname ? (
                  <p className="font-mono text-sm break-all">{luna.hostname}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Linked, but no public name yet.{" "}
                    <Link className="underline" to="/onboarding">
                      Finish setup
                    </Link>
                  </p>
                )}
                {luna.setup_secret && (
                  <p className="text-sm leading-relaxed">
                    First Luna login still needs this one-time code:{" "}
                    <span className="font-mono break-all">{luna.setup_secret}</span>
                  </p>
                )}
                <div className="flex flex-col sm:flex-row gap-2">
                  {luna.hostname && (
                    <Button variant="secondary" size="sm" asChild>
                      <a href={`https://${luna.hostname}`} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        Open
                      </a>
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={showCode}>
                    Show code
                  </Button>
                  {!confirmUnbind && (
                    <Button variant="outline" size="sm" onClick={() => setConfirmUnbind(true)}>
                      Unbind Luna
                    </Button>
                  )}
                </div>
              </div>
              {confirmUnbind && (
                <div className="rounded-large-element bg-background text-foreground border border-border px-4 py-4 space-y-3">
                  <p className="text-sm leading-relaxed">
                    The public address goes away. Cloud backups stay on this account (archived) and stay billed until you turn payment off. Someone else can bind this Luna later with the same device code.
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
            </>
          )}
          {shownCode && (
            <div className="rounded-large-element bg-background text-foreground border border-border px-4 py-4 space-y-3">
              <p className="font-mono text-xl tracking-widest break-all">{shownCode}</p>
              <Button variant="secondary" onClick={() => copyCode(shownCode)}>
                <Copy className="h-4 w-4" />
                {copied ? "Copied" : "Copy code"}
              </Button>
            </div>
          )}
          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    </Layout>
  );
}
