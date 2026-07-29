import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge, StatusBadge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";
import { Check, X, Key, Copy, ArrowUpCircle, Shield, Zap } from "lucide-react";

export default function Dashboard() {
  const { account } = useAuth();
  const queryClient = useQueryClient();
  const [generatedKey, setGeneratedKey] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  const { data: devicesData } = useQuery({
    queryKey: ["devices"],
    queryFn: api.getDevices,
  });
  const { data: keysData } = useQuery({
    queryKey: ["license-keys"],
    queryFn: api.getLicenseKeys,
  });
  const { data: consentData } = useQuery({
    queryKey: ["consent-requests"],
    queryFn: api.getConsentRequests,
  });
  const { data: plansData } = useQuery({
    queryKey: ["plans"],
    queryFn: api.getPlans,
  });

  const generateKeyMut = useMutation({
    mutationFn: () => api.generateLicenseKey(),
    onSuccess: (data) => {
      setGeneratedKey(data);
      queryClient.invalidateQueries({ queryKey: ["license-keys"] });
    },
  });

  const revokeMut = useMutation({
    mutationFn: api.revokeLicenseKey,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["license-keys"] }),
  });

  const consentMut = useMutation({
    mutationFn: ({ id, decision }) => api.respondConsent(id, decision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["consent-requests"] }),
  });

  const checkoutMut = useMutation({
    mutationFn: (planId) => api.createCheckout(planId),
    onSuccess: (data) => {
      setShowUpgradeModal(false);
      if (data.checkout_url && data.checkout_url !== "#") {
        window.location.href = data.checkout_url;
      }
    },
  });

  const devices = devicesData?.devices || [];
  const licenseKeys = keysData?.license_keys || [];
  const consentRequests = consentData?.consent_requests || [];
  const plans = plansData?.plans || [];
  const hasDevice = devices.length > 0;

  // Account plan from auth context (set at login/registration)
  const accountPlanId = account?.plan_id || "free";
  const accountPlan = plans.find((p) => p.id === accountPlanId);
  const upgradePlans = plans.filter((p) => p.price_monthly > (accountPlan?.price_monthly || 0));

  const copyKey = (key) => {
    navigator.clipboard.writeText(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-6">Dashboard</h2>

      {/* Current plan card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Current Plan
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono text-lg">{accountPlan?.name || "Connect Free"}</p>
              <p className="text-sm text-muted-foreground">
                {accountPlan?.price_monthly === 0
                  ? "Free plan — no credit card required."
                  : `$${(accountPlan?.price_monthly / 100).toFixed(0)}/mo`}
              </p>
            </div>
            {upgradePlans.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowUpgradeModal(true)}
              >
                <ArrowUpCircle className="h-4 w-4" />
                Upgrade
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Upgrade modal */}
      {showUpgradeModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
          onClick={() => setShowUpgradeModal(false)}
        >
          <div
            className="w-full max-w-lg rounded-large-element border border-border bg-card text-card-foreground shadow-[0_32px_80px_rgba(0,0,0,0.24)] p-6 motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-mono text-xl flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Upgrade your plan
              </h3>
              <button
                type="button"
                onClick={() => setShowUpgradeModal(false)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm text-muted-foreground mb-4">
              You're currently on {accountPlan?.name || "Connect Free"}. Choose a plan below to upgrade.
            </p>

            <div className="space-y-3">
              {upgradePlans.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={checkoutMut.isPending}
                  onClick={() => checkoutMut.mutate(p.id)}
                  className="w-full rounded-large-element border-2 border-border p-4 text-left transition-all motion-safe:duration-200 hover:border-primary/40 disabled:opacity-50"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-mono text-base">{p.name}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">{p.description}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-lg">${(p.price_monthly / 100).toFixed(0)}</p>
                      <p className="text-xs text-muted-foreground">per month</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {checkoutMut.isPending && (
              <p className="text-sm text-muted-foreground mt-3 text-center">
                Redirecting to payment…
              </p>
            )}
          </div>
        </div>
      )}

      {/* Consent requests — only show if there are any */}
      {consentRequests.length > 0 && (
        <Card className="mb-6 border-warning/30">
          <CardHeader>
            <CardTitle className="text-warning">Pending Consent Requests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Support staff are requesting access to files on your device. Review each request and approve or deny.
            </p>
            {consentRequests.map((cr) => (
              <div key={cr.id} className="flex items-center justify-between rounded-lg border border-border p-3">
                <div>
                  <p className="font-mono text-sm">{cr.path}</p>
                  <p className="text-xs text-muted-foreground">{cr.scope_type} · expires {cr.expires_at ? new Date(cr.expires_at).toLocaleString() : "—"}</p>
                </div>
                <div className="flex gap-2">
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

      {/* No device state — generate a key */}
      {!hasDevice && !generatedKey && licenseKeys.length === 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Get Started</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Generate a license key to connect your LibreServ device to Connect.
              Then enter the key on your device to activate.
            </p>
            <Button onClick={() => generateKeyMut.mutate()} loading={generateKeyMut.isPending}>
              <Key className="h-4 w-4" /> Generate License Key
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Generated key display */}
      {generatedKey && (
        <Card className="mb-6 border-success/30">
          <CardHeader>
            <CardTitle className="text-success">Your License Key</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              Enter this key on your LibreServ device to activate Connect.
              Save it now — you won't be able to see the full key again.
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-border p-4">
              <code className="font-mono text-lg flex-1 break-all">{generatedKey.license_key}</code>
              <Button variant="outline" size="sm" onClick={() => copyKey(generatedKey.license_key)}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <Button variant="ghost" size="sm" className="mt-3" onClick={() => setGeneratedKey(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {/* License key info */}
      {licenseKeys.length > 0 && (
        <div className="mb-6">
          <h3 className="font-mono text-lg mb-4">License Key</h3>
          <div className="space-y-2">
            {licenseKeys.map((lk) => (
              <Card key={lk.id} className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm">{lk.key_prefix}</p>
                  <p className="text-sm text-muted-foreground">{lk.plan_name}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={lk.status} />
                  {lk.status !== "revoked" && (
                    <Button variant="ghost" size="sm" onClick={() => revokeMut.mutate(lk.id)} loading={revokeMut.isPending}>
                      Revoke
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Device info — one device per account */}
      {hasDevice && (
        <div className="mb-6">
          <h3 className="font-mono text-lg mb-4">Your Device</h3>
          <div className="grid gap-3">
            {devices.map((d) => (
              <Card key={d.id}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-mono text-sm">{d.id}</p>
                    <p className="text-sm text-muted-foreground">{d.plan_name}</p>
                  </div>
                  <StatusBadge status={d.is_active ? "active" : "inactive"} />
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </Layout>
  );
}
