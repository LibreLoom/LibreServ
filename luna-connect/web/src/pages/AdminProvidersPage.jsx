import { useEffect, useState } from "react";
import { AdminLayout } from "../components/AdminLayout.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Input } from "../components/ui/input.jsx";
import ShakeTarget from "../components/ui/shake-target.jsx";
import { Label } from "../components/ui/label.jsx";
import { adminApi } from "../context/AdminAuthContext.jsx";

/**
 * Service catalog for Luna Connect admin connections.
 * Keys must match internal/api/handlers/providers.go allowedService values.
 * Stripe is applied at runtime (ApplyStripeFromDB). B2 keys drive cloud backup
 * object storage (one private bucket per Luna). Resend sends account verification
 * emails when configured. Cloudflare creates tunnels and DNS for remote Luna addresses.
 */
const SERVICE_FIELDS = {
  stripe: {
    label: "Billing (Stripe)",
    description:
      "Takes card payments and monthly backup charges. Storage is $8 per TB per month ($0.008 per GB), billed on the month’s average amount stored — not a single day-end snapshot. Downloads are free up to 3× that average; extra download traffic is $0.01 per GB. In Stripe Dashboard → Billing → Meters, create two meters with aggregation Last: (1) event name luna_backup_gb for average storage GB, (2) event name luna_backup_egress_gb for egress overage GB. Link usage-based prices: $0.008/GB to the storage meter, $0.01/GB to the egress meter. Get API keys from Developers → API keys; webhook secret under Developers → Webhooks for this Luna Connect URL.",
    credentials: [
      { key: "secret_key", label: "Secret key", placeholder: "sk_live_… or sk_test_…", type: "password" },
      { key: "webhook_secret", label: "Webhook secret", placeholder: "whsec_…", type: "password" },
    ],
    settings: [
      { key: "publishable_key", label: "Publishable key", placeholder: "pk_live_… or pk_test_…" },
      { key: "meter_event_name", label: "Storage meter event name", placeholder: "luna_backup_gb" },
      { key: "price_id", label: "Storage price ID ($0.008/GB-mo)", placeholder: "price_…" },
      { key: "egress_meter_event_name", label: "Egress overage meter event name", placeholder: "luna_backup_egress_gb" },
      { key: "egress_price_id", label: "Egress overage price ID ($0.01/GB)", placeholder: "price_…" },
    ],
  },
  smtp: {
    label: "Email (Resend)",
    description:
      "Sends verification emails when someone creates a Luna Connect account. Create an API key at resend.com → API Keys. Optionally set From address to a verified domain (for example Luna Connect <noreply@yourdomain.com>).",
    credentials: [
      { key: "api_key", label: "Resend API key", placeholder: "re_…", type: "password" },
    ],
    settings: [
      { key: "from_email", label: "From address", placeholder: "luna@yourdomain.com" },
    ],
  },
  backup: {
    label: "Off-site storage (Backblaze B2)",
    description:
      "Stores each Luna’s cloud backup in its own private Backblaze B2 bucket. Use a master application key from backblaze.com → Application Keys (capabilities: list buckets, create buckets, write files, delete files, and create keys). Bucket name prefix defaults to luna-backup — each device becomes prefix-plus-device-id.",
    credentials: [
      { key: "account_id", label: "B2 key ID", placeholder: "001…" },
      { key: "application_key", label: "B2 application key", placeholder: "K0…", type: "password" },
    ],
    settings: [
      { key: "bucket_prefix", label: "Bucket name prefix", placeholder: "luna-backup" },
    ],
  },
  cloudflare: {
    label: "Remote access (Cloudflare)",
    description:
      "Creates a Cloudflare Tunnel and DNS name for each Luna when someone picks a name during setup (for example kitchen.luna.servers.libreloom.org). Your API token is on cloudflare.com → Profile → API Tokens → Create Token. Give it Cloudflare Tunnel Edit and DNS Edit on the public zone. Zone ID is on the zone’s Overview page in the Cloudflare dashboard (right-hand column).",
    credentials: [
      { key: "account_id", label: "Account ID", placeholder: "32-character hex" },
      { key: "api_token", label: "API token", placeholder: "Create token with Tunnel Edit + DNS Edit", type: "password" },
    ],
    settings: [
      { key: "zone_id", label: "Zone ID", placeholder: "32-character hex for luna.servers.libreloom.org" },
    ],
  },
};

const SERVICE_ORDER = ["stripe", "smtp", "backup", "cloudflare"];

function emptyForm(service) {
  const spec = SERVICE_FIELDS[service];
  const credentials = {};
  const settings = {};
  spec.credentials.forEach((f) => {
    credentials[f.key] = "";
  });
  spec.settings.forEach((f) => {
    settings[f.key] = "";
  });
  return { service, name: spec.label, credentials, settings, enabled: true };
}

export default function AdminProvidersPage() {
  const [providers, setProviders] = useState([]);
  const [configStatus, setConfigStatus] = useState({});
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState("");
  const [forms, setForms] = useState(() => {
    const init = {};
    SERVICE_ORDER.forEach((s) => {
      init[s] = emptyForm(s);
    });
    return init;
  });

  const load = () =>
    adminApi("/admin/providers")
      .then((data) => {
        setProviders(data.providers || []);
        setConfigStatus(data.config_status || {});
        setError("");
      })
      .catch((err) => setError(err.message));

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  function updateField(service, kind, key, value) {
    setForms((prev) => ({
      ...prev,
      [service]: {
        ...prev[service],
        [kind]: { ...prev[service][kind], [key]: value },
      },
    }));
  }

  function startEdit(p) {
    if (editingId === p.id) {
      resetForm(p.service);
      return;
    }
    setEditingId(p.id);
    const spec = SERVICE_FIELDS[p.service];
    const credentials = {};
    const settings = {};
    (spec?.credentials || []).forEach((f) => {
      // Never put masked secrets back into the form; leave blank to keep existing.
      credentials[f.key] = f.type === "password" ? "" : p.credentials?.[f.key] || "";
    });
    (spec?.settings || []).forEach((f) => {
      settings[f.key] = p.settings?.[f.key] || "";
    });
    setForms((prev) => ({
      ...prev,
      [p.service]: {
        service: p.service,
        name: p.name,
        credentials,
        settings,
        enabled: p.enabled,
      },
    }));
  }

  function resetForm(service) {
    setForms((prev) => ({ ...prev, [service]: emptyForm(service) }));
    setEditingId(null);
  }

  async function saveCreate(service) {
    setBusy(`create-${service}`);
    setError("");
    setFormError("");
    try {
      await adminApi("/admin/providers", {
        method: "POST",
        body: JSON.stringify(forms[service]),
      });
      resetForm(service);
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function saveUpdate(service) {
    setBusy(`update-${service}`);
    setError("");
    setFormError("");
    try {
      await adminApi(`/admin/providers/${encodeURIComponent(editingId)}`, {
        method: "PUT",
        body: JSON.stringify(forms[service]),
      });
      resetForm(service);
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function removeProvider(id) {
    if (!window.confirm("Remove this connection? Luna Connect will fall back to the config file if one is set.")) {
      return;
    }
    setBusy(`del-${id}`);
    setError("");
    try {
      await adminApi(`/admin/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (editingId === id) setEditingId(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  function statusBadge(service) {
    const st = configStatus[service];
    if (!st) return null;
    if (service === "cloudflare" && st.mock_mode && !st.configured) {
      return <Badge variant="outline">dev mock mode</Badge>;
    }
    if (service === "stripe" && st.configured && st.enabled && !st.webhook_ready) {
      return (
        <>
          <Badge variant="success">{st.source === "config" ? "from config file" : "connected"}</Badge>
          <Badge variant="outline">webhook secret missing — Stripe retries will fail</Badge>
        </>
      );
    }
    if (st.configured && st.enabled) {
      return <Badge variant="success">{st.source === "config" ? "from config file" : "connected"}</Badge>;
    }
    if (st.configured && !st.enabled) {
      return <Badge variant="outline">saved, disabled</Badge>;
    }
    return <Badge variant="outline">not set</Badge>;
  }

  return (
    <AdminLayout>
      <h2 className="font-mono text-2xl mb-2">Connections</h2>
      <p className="text-muted-foreground mb-6 max-w-3xl">
        Stripe keys apply right away for billing. Backblaze B2 keys turn on off-site cloud
        backup (one private bucket per Luna). Resend sends account verification emails when
        configured. Cloudflare keys create remote Luna addresses when someone picks a name.
        Secrets stay in the database and are never shown in full again; leave a secret
        blank when editing to keep the current value. If nothing is saved here, Stripe and
        Cloudflare still use the config file, and cloud backup falls back to this server’s disk.
      </p>

      {loading ? (
        <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading connections…</p>
      ) : null}
      {error ? <p className="text-sm text-error mb-4">{error}</p> : null}

      <div className="space-y-8">
        {SERVICE_ORDER.map((service) => {
          const spec = SERVICE_FIELDS[service];
          const form = forms[service];
          const items = providers.filter((p) => p.service === service);
          const isEditing = editingId !== null && items.some((p) => p.id === editingId);

          return (
            <section key={service}>
              <CardHeader className="px-0">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>{spec.label}</CardTitle>
                  {statusBadge(service)}
                </div>
                <CardDescription>{spec.description}</CardDescription>
              </CardHeader>

              <div className="space-y-2 mb-4">
                {items.map((p) => (
                  <Card key={p.id} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between animate-fade-in">
                    <div>
                      <p className="font-mono">{p.name}</p>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {p.enabled ? (
                          <Badge variant="success">enabled</Badge>
                        ) : (
                          <Badge variant="outline">disabled</Badge>
                        )}
                        {Object.entries(p.has_credentials || {}).map(([k, ok]) =>
                          ok ? (
                            <Badge key={k} variant="outline">
                              {k.replaceAll("_", " ")} set
                            </Badge>
                          ) : null
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => startEdit(p)}>
                        {isEditing && editingId === p.id ? "Cancel" : "Edit"}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        loading={busy === `del-${p.id}`}
                        onClick={() => removeProvider(p.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </Card>
                ))}
                {items.length === 0 && (
                  <Card>
                    <p className="text-muted-foreground text-center">
                      No {spec.label.toLowerCase()} connection saved yet. Add one below
                      {service === "stripe" && configStatus.stripe?.configured
                        ? " (config file is in use until you add one here)"
                        : ""}
                      {service === "cloudflare" && configStatus.cloudflare?.configured
                        ? " (config file is in use until you add one here)"
                        : ""}
                      .
                    </p>
                  </Card>
                )}
              </div>

              {(items.length === 0 || isEditing) && (
                <Card className="animate-fade-in">
                  <CardContent className="pt-2">
                    <div className="grid gap-3 md:grid-cols-2">
                      {spec.credentials.map((f) => (
                        <div key={f.key}>
                          <Label htmlFor={`${service}-${f.key}`}>{f.label}</Label>
                          <ShakeTarget shake={formError}>
                            <Input
                              id={`${service}-${f.key}`}
                              type={f.type || "text"}
                              placeholder={
                                isEditing && f.type === "password"
                                  ? "Leave blank to keep current"
                                  : f.placeholder
                              }
                              autoComplete="off"
                              value={form.credentials[f.key] || ""}
                              onChange={(e) => updateField(service, "credentials", f.key, e.target.value)}
                            />
                          </ShakeTarget>
                        </div>
                      ))}
                      {spec.settings.map((f) => (
                        <div key={f.key}>
                          <Label htmlFor={`${service}-${f.key}`}>{f.label}</Label>
                          <ShakeTarget shake={formError}>
                            <Input
                              id={`${service}-${f.key}`}
                              placeholder={f.placeholder}
                              autoComplete="off"
                              value={form.settings[f.key] || ""}
                              onChange={(e) => updateField(service, "settings", f.key, e.target.value)}
                            />
                          </ShakeTarget>
                        </div>
                      ))}
                    </div>
                    {formError && <p className="text-sm text-error">{formError}</p>}
                    <label className="mt-4 flex items-center gap-2 font-mono text-sm">
                      <input
                        type="checkbox"
                        checked={!!form.enabled}
                        onChange={(e) =>
                          setForms((prev) => ({
                            ...prev,
                            [service]: { ...prev[service], enabled: e.target.checked },
                          }))
                        }
                      />
                      Enabled
                    </label>
                    <div className="flex gap-2 mt-4">
                      {isEditing ? (
                        <>
                          <Button
                            size="sm"
                            loading={busy === `update-${service}`}
                            onClick={() => saveUpdate(service)}
                          >
                            Save
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => resetForm(service)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          loading={busy === `create-${service}`}
                          onClick={() => saveCreate(service)}
                        >
                          Add connection
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            </section>
          );
        })}
      </div>
    </AdminLayout>
  );
}
