import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge, StatusBadge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";
import { Check, X, Key, Plus, Copy } from "lucide-react";

export default function Dashboard() {
  const { account } = useAuth();
  const queryClient = useQueryClient();
  const [generatedKey, setGeneratedKey] = useState(null);
  const [copied, setCopied] = useState(false);

  const { data: devicesData } = useQuery({
    queryKey: ["devices"],
    queryFn: api.getDevices,
  });
  const { data: keysData } = useQuery({
    queryKey: ["license-keys"],
    queryFn: api.getLicenseKeys,
  });
  const { data: consentData } = useQuery({
    queryKey: ["consent"],
    queryFn: api.getConsentRequests,
  });

  const generateKeyMut = useMutation({
    mutationFn: api.generateLicenseKey,
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
    mutationFn: /** @param {{id: string, decision: string}} vars */ (vars) => api.respondConsent(vars.id, vars.decision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["consent"] }),
  });

  const devices = devicesData?.devices || [];
  const licenseKeys = keysData?.license_keys || [];
  const consentRequests = consentData?.consent_requests || [];
  const hasDevices = devices.length > 0;
  const activeKeys = licenseKeys.filter((k) => k.status === "unused" || k.status === "active");

  const copyKey = (key) => {
    navigator.clipboard.writeText(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-6">Dashboard</h2>

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

      {/* No devices state — show how to get started */}
      {!hasDevices && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Get Started</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              To connect your LibreServ device to Connect, you need a license key.
              Choose a plan below to generate a key, then enter it on your device in Settings → Connect.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => generateKeyMut.mutate("free")} loading={generateKeyMut.isPending}>
                <Key className="h-4 w-4" /> Get Free Key
              </Button>
              <Button variant="outline" onClick={() => generateKeyMut.mutate("lite")} loading={generateKeyMut.isPending}>
                Get Lite Key ($6/mo)
              </Button>
              <Button variant="outline" onClick={() => generateKeyMut.mutate("one")} loading={generateKeyMut.isPending}>
                Get One Key ($25/mo)
              </Button>
            </div>
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
              Enter this key on your LibreServ device in Settings → Connect to activate your subscription.
              Save it now — you won't be able to see the full key again.
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-border p-4">
              <code className="font-mono text-lg flex-1">{generatedKey.license_key}</code>
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

      {/* License keys list */}
      {licenseKeys.length > 0 && (
        <div className="mb-6">
          <h3 className="font-mono text-lg mb-4">License Keys</h3>
          <div className="space-y-2">
            {licenseKeys.map((lk) => (
              <Card key={lk.id} className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm">{lk.key_prefix}</p>
                  <p className="text-sm text-muted-foreground">{lk.plan_name}</p>
                  {lk.device_id && <p className="text-xs text-muted-foreground">Device: {lk.device_id}</p>}
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

      {/* Devices list — only show if there are devices */}
      {hasDevices && (
        <div className="mb-6">
          <h3 className="font-mono text-lg mb-4">Your Devices</h3>
          <div className="grid gap-3 md:grid-cols-2">
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

      {/* Generate more keys — only show if user already has devices or keys */}
      {(hasDevices || licenseKeys.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Plus className="h-4 w-4" /> Add Another Device</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Generate a new license key to connect another LibreServ device.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => generateKeyMut.mutate("free")} loading={generateKeyMut.isPending}>
                Free
              </Button>
              <Button variant="outline" size="sm" onClick={() => generateKeyMut.mutate("lite")} loading={generateKeyMut.isPending}>
                Lite ($6/mo)
              </Button>
              <Button variant="outline" size="sm" onClick={() => generateKeyMut.mutate("one")} loading={generateKeyMut.isPending}>
                One ($25/mo)
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </Layout>
  );
}
