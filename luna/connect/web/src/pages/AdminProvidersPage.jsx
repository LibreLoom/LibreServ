import { useEffect, useState } from "react";
import PathTrail from "@libreloom/ui/components/common/PathTrail.jsx";
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
    description: (
      <>
        Takes card payments and the monthly cloud backup bill. Storage costs $0.008 per GB per month on the month’s average, with a $3 minimum once an account stores anything. Downloads are free up to 3× what you store, then $0.01 per GB. In <PathTrail steps={["Stripe Dashboard", "Billing", "Meters"]} />, create two meters with aggregation Last: luna_backup_gb (storage GB) and luna_egress_gb (extra download GB). Link a $0.008/GB price to the storage meter and a $0.01/GB price to the download meter. The API keys are in <PathTrail steps={["Developers", "API keys"]} />, and the webhook secret for this Luna Connect address is in <PathTrail steps={["Developers", "Webhooks"]} />.
      </>
    ),
    credentials: [
      { key: "secret_key", label: "Secret key", placeholder: "sk_live_… or sk_test_…", type: "password" },
      { key: "webhook_secret", label: "Webhook secret", placeholder: "whsec_…", type: "password" },
    ],
    settings: [
      { key: "publishable_key", label: "Publishable key", placeholder: "pk_live_… or pk_test_…" },
      { key: "meter_event_name", label: "Storage meter event name", placeholder: "luna_backup_gb" },
      { key: "price_id", label: "Storage price ID ($0.008/GB-mo)", placeholder: "price_…" },
      { key: "egress_meter_event_name", label: "Egress overage meter event name", placeholder: "luna_egress_gb" },
      { key: "egress_price_id", label: "Egress overage price ID ($0.01/GB)", placeholder: "price_…" },
    ],
  },
  smtp: {
    label: "Email (Resend)",
    description: (
      <>
        Sends the verification email when someone creates a Luna Connect account. Create an API key at <PathTrail steps={["resend.com", "API Keys"]} />{". You can set a From address on a domain you verified in Resend (for example Luna Connect <noreply@yourdomain.com>)."}
      </>
    ),
    credentials: [
      { key: "api_key", label: "Resend API key", placeholder: "re_…", type: "password" },
    ],
    settings: [
      { key: "from_email", label: "From address", placeholder: "luna@yourdomain.com" },
    ],
  },
  backup: {
    label: "Off-site storage (Backblaze B2)",
    description: (
      <>
        Stores each Luna’s cloud backup in its own private Backblaze B2 bucket. Without this connection, cloud backup uses this server’s disk. Use the master application key from <PathTrail steps={["backblaze.com", "Application Keys"]} />, because Luna Connect creates buckets and keys with it. Each bucket name starts with the prefix (default luna-backup, at most 12 characters).
      </>
    ),
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
    description: (
      <>
        Creates a Cloudflare Tunnel and DNS name for each Luna when someone picks a name (for example kitchen.luna.servers.libreloom.org). Create the API token at <PathTrail steps={["cloudflare.com", "Profile", "API Tokens", "Create Token"]} />, with Cloudflare Tunnel Edit and DNS Edit on the public zone. The Zone ID is on the zone’s Overview page (right-hand column).
      </>
    ),
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
  const [configStatus, setConfigStatus] = useState(
    /** @type {Record<string, any>} */ ({}),
  );
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

  async function removeProvider(id, service) {
    const fallback = {
      stripe: "Billing falls back to the config file, if it has Stripe keys.",
      cloudflare: "Remote access falls back to the config file, if it has Cloudflare keys.",
      backup: "New cloud backups go to this server's disk.",
      smtp: "Luna Connect stops sending verification emails.",
    };
    if (!window.confirm(`Remove this connection? ${fallback[service] || ""}`.trim())) {
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
          <Badge variant="outline">webhook secret missing: Luna Connect rejects every Stripe webhook</Badge>
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
        Saved changes apply right away. Secrets are never shown in full again, so leave a
        secret blank when you edit to keep the current value.
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
                        onClick={() => removeProvider(p.id, p.service)}
                      >
                        Delete
                      </Button>
                    </div>
                  </Card>
                ))}
                {items.length === 0 && (
                  <Card>
                    <p className="text-muted-foreground text-center">
                      No saved connection. Add one below
                      {service === "stripe" && configStatus.stripe?.configured
                        ? " (the config file is in use until you add one here)"
                        : ""}
                      {service === "cloudflare" && configStatus.cloudflare?.configured
                        ? " (the config file is in use until you add one here)"
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
