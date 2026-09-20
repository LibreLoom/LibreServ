import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Dialog } from "../components/ui/dialog.jsx";
import { StatusBadge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";
import { copyToClipboard } from "../lib/clipboard.js";
import {
  Check, X, Key, Copy, Shield, Loader2, MailCheck,
  AlertCircle, Globe, ArrowRight, RefreshCw,
} from "lucide-react";

/**
 * Dashboard — the portal home. Shows your plan, your device's address and
 * status, your Connect key, and anything that needs action (consent requests,
 * email verification).
 */
export default function Dashboard() {
  const { account } = useAuth();
  const queryClient = useQueryClient();
  const [generatedKey, setGeneratedKey] = useState(null);
  const [copied, setCopied] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [confirmRegen, setConfirmRegen] = useState(false);

  const verified = !!account?.email_verified;

  const { data: devicesData, isLoading: devicesLoading } = useQuery({
    queryKey: ["devices"], queryFn: api.getDevices, enabled: verified,
  });
  const { data: keysData, isLoading: keysLoading } = useQuery({
    queryKey: ["connect-keys"], queryFn: api.getConnectKeys, enabled: verified,
  });
  const { data: consentData } = useQuery({
    queryKey: ["consent-requests"], queryFn: api.getConsentRequests, enabled: verified,
  });
  const { data: plansData, isLoading: plansLoading } = useQuery({
    queryKey: ["plans"], queryFn: api.getPlans,
  });

  const loading = verified && (devicesLoading || keysLoading || plansLoading);

  const devices = devicesData?.devices || [];
  const connectKeys = keysData?.connect_keys || [];
  const consentRequests = consentData?.consent_requests || [];
  const plans = plansData?.plans || [];
  const activeDevice = devices.find((d) => d.is_active);

  const accountPlanId = account?.plan_id || "free";
  const accountPlan = plans.find((p) => p.id === accountPlanId);
  const upgradePlans = plans.filter((p) => p.price_monthly > (accountPlan?.price_monthly || 0));

  const generateKeyMut = useMutation({
    mutationFn: () => api.generateConnectKey(),
    onSuccess: (data) => {
      setKeyError("");
      setGeneratedKey(data);
      queryClient.invalidateQueries({ queryKey: ["connect-keys"] });
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (err) => setKeyError(err.message || "Could not regenerate your Connect key."),
  });

  const consentMut = useMutation({
    mutationFn: ({ id, decision }) => api.respondConsent(id, decision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["consent-requests"] }),
  });

  const copyKey = async (key) => {
    const ok = await copyToClipboard(key);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <h1 className="font-mono text-xl mb-8">Dashboard</h1>

        {!verified ? (
          <Card>
            <CardContent className="py-12 flex flex-col items-center text-center">
              <MailCheck className="w-7 h-7 text-warning mb-6" />
              <h3 className="font-mono text-lg mb-3">Verify your email to continue</h3>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-sm mb-8">
                We sent a verification link to{" "}
                <span className="font-mono text-foreground">{account?.email}</span>.
                Until you click it, your dashboard, devices, license keys, and
                billing are all locked.
              </p>
              <Button asChild>
                <Link to="/security">Go to Security</Link>
              </Button>
            </CardContent>
          </Card>
        ) : loading ? (
          <DashboardSkeleton />
        ) : (
          <div className="space-y-8">
            {/* Plan summary */}
            <section className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Shield className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="font-mono">{accountPlan?.name || "Connect Free"}</p>
                  <p className="text-sm text-muted-foreground">
                    {accountPlan?.price_monthly === 0
                      ? "Free — no card required"
                      : `$${(accountPlan?.price_monthly / 100).toFixed(0)}/month`}
                  </p>
                </div>
              </div>
              {upgradePlans.length > 0 && (
                <Button variant="outline" size="sm" asChild>
                  <Link to="/plans">Upgrade</Link>
                </Button>
              )}
            </section>

            {/* Consent requests */}
            {consentRequests.length > 0 && (
              <Card className="border-warning/30">
                <CardHeader>
                  <CardTitle className="text-warning text-base">Pending consent requests</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Support staff are requesting access to files on your device.
                  </p>
                  {consentRequests.map((cr) => (
                    <div key={cr.id} className="flex items-center justify-between rounded-large-element border border-border p-3">
                      <div className="min-w-0">
                        <p className="font-mono text-sm truncate">{cr.path}</p>
                        <p className="text-xs text-muted-foreground">
                          {cr.scope_type} · expires {cr.expires_at ? new Date(cr.expires_at).toLocaleString() : "—"}
                        </p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Button size="sm" onClick={() => consentMut.mutate({ id: cr.id, decision: "granted" })} loading={consentMut.isPending}>
                          <Check className="h-4 w-4" /> Approve
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => consentMut.mutate({ id: cr.id, decision: "denied" })} loading={consentMut.isPending}>
                          <X className="h-4 w-4" /> Deny
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Device — the thing the user actually cares about */}
            <section>
              <SectionHeader label="Your device" />
              <div className="space-y-4">
                {activeDevice && <DeviceCard device={activeDevice} />}

                {connectKeys.length > 0 || generatedKey ? (
                  <KeySection
                    connectKeys={connectKeys}
                    generatedKey={generatedKey}
                    copied={copied}
                    onCopy={copyKey}
                    onDismiss={() => setGeneratedKey(null)}
                    onRegenerate={() => setConfirmRegen(true)}
                    regenerating={generateKeyMut.isPending}
                    error={keyError}
                  />
                ) : activeDevice ? null : (
                  <Card>
                    <CardHeader><CardTitle className="text-base">Get started</CardTitle></CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground mb-4">
                        Generate a Connect key, then enter it on your LibreServ
                        device to link it to your account.
                      </p>
                      <Button onClick={() => generateKeyMut.mutate()} loading={generateKeyMut.isPending}>
                        <Key className="h-4 w-4" /> Generate Connect key
                      </Button>
                      {keyError && <ErrorLine message={keyError} />}
                    </CardContent>
                  </Card>
                )}
              </div>
            </section>
          </div>
        )}
      </div>

      {/* Regenerate key — destructive (deactivates the device) but never
          changes the domain name; the modal makes both explicit. */}
      <Dialog
        open={confirmRegen}
        onOpenChange={setConfirmRegen}
        title="Regenerate your Connect key?"
        danger
        confirmLabel="Regenerate key"
        cancelLabel="Cancel"
        loading={generateKeyMut.isPending}
        onConfirm={() => {
          setConfirmRegen(false);
          generateKeyMut.mutate();
        }}
      >
        <p className="text-sm text-muted-foreground leading-relaxed">
          Your current key stops working immediately and your device will be
          disconnected. You'll need to enter the new key on your device to
          reconnect it.
        </p>
        <p className="flex items-start gap-2 rounded-large-element border border-border bg-secondary text-primary p-3 mt-4 text-sm leading-relaxed">
          <Shield className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
          <span>
            Your domain name <span className="font-mono">{activeDevice?.current_domain || "address"}</span>{" "}
            will not change.
          </span>
        </p>
      </Dialog>
    </Layout>
  );
}

function SectionHeader({ label }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground shrink-0">{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function ErrorLine({ message }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-error mt-3">
      <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {message}
    </p>
  );
}

function DeviceCard({ device }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Globe className="w-5 h-5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <p className="font-mono truncate">{device.current_domain}</p>
              <p className="text-sm text-muted-foreground">
                {device.plan_name}
                {device.has_custom_domain ? " · custom domain" : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <StatusBadge status={device.is_active ? "active" : "inactive"} />
            <Button variant="outline" size="sm" asChild>
              <Link to="/domains">Domain</Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function KeySection({ connectKeys, generatedKey, copied, onCopy, onDismiss, onRegenerate, regenerating, error }) {
  return (
    <div className="space-y-4">
      {generatedKey && (
        <Card className="border-success/30">
          <CardHeader>
            <CardTitle className="text-success text-base">Your Connect key</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              Enter this on your device to activate Connect. It's shown only once.
            </p>
            <div className="flex items-center gap-2 rounded-large-element border border-border p-4">
              <code className="font-mono text-base flex-1 break-all">{generatedKey.connect_key}</code>
              <Button variant="outline" size="sm" onClick={() => onCopy(generatedKey.connect_key)}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <Button variant="ghost" size="sm" className="mt-3" onClick={onDismiss}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {connectKeys.map((lk) => (
        <Card key={lk.id}>
          <CardContent className="py-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-sm">{lk.key_prefix}</p>
              <p className="text-sm text-muted-foreground">{lk.plan_name}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <StatusBadge status={lk.status} />
              <Button variant="outline" size="sm" onClick={onRegenerate} loading={regenerating}>
                <RefreshCw className="h-4 w-4" /> Regenerate
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
      {error && <ErrorLine message={error} />}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-5 w-5 rounded bg-accent" />
        <div className="space-y-2">
          <div className="h-4 w-32 rounded bg-accent" />
          <div className="h-3 w-24 rounded bg-accent" />
        </div>
      </div>
      <div className="h-3 w-24 rounded bg-accent" />
      <div className="h-20 w-full rounded-large-element bg-accent" />
    </div>
  );
}