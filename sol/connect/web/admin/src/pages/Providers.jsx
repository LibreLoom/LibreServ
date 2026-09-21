import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";

// Service catalog: which credentials/settings each provider type needs.
// Keys must match what connect/internal/services/services.go reads via
// prov.Credential(...) and prov.Setting(...).
const SERVICE_FIELDS = {
  backup: {
    label: "Backups (Backblaze B2)",
    description:
      "When a device enables cloud backups, Connect creates one private B2 bucket per device and a scoped key for it. Enter the master B2 account credentials here.",
    credentials: [
      { key: "account_id", label: "B2 Key ID", placeholder: "001xxxxxxxxxxxxxxxxxxxxx" },
      { key: "application_key", label: "B2 Application Key", placeholder: "K0xxxxxxxxxxxxxxxxxxxx", type: "password" },
    ],
    settings: [
      { key: "bucket_prefix", label: "Bucket Prefix", placeholder: "libreserv-backup" },
    ],
  },
  smtp: {
    label: "Email (Resend)",
    description:
      "When a device enables email through Connect, a scoped Resend API key is created per device for sending mail. Enter the master Resend API key here.",
    credentials: [
      { key: "api_key", label: "Resend API Key", placeholder: "re_xxxxxxxxxxxxxxxx", type: "password" },
    ],
    settings: [],
  },
  dns: {
    label: "DNS (Cloudflare)",
    description:
      "When a device gets a subdomain, Connect creates an A record pointing the subdomain at the device's IP. Enter the Cloudflare API token here. The token needs Zone:DNS:Edit permission on the zone.",
    credentials: [
      { key: "api_token", label: "Cloudflare API Token", placeholder: "cf_xxxxxxxxxxxxxxxxxxxxxxxx", type: "password" },
    ],
    settings: [
      { key: "zone", label: "DNS Zone", placeholder: "servers.libreloom.org" },
    ],
  },
};

const SERVICE_ORDER = ["backup", "smtp", "dns"];

function emptyForm(service) {
  const spec = SERVICE_FIELDS[service];
  const credentials = {};
  const settings = {};
  spec.credentials.forEach((f) => (credentials[f.key] = ""));
  spec.settings.forEach((f) => (settings[f.key] = ""));
  return { service, name: spec.label, credentials, settings, enabled: true };
}

export default function Providers() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState(null);
  // One form per service section, keyed by service.
  const [forms, setForms] = useState(() => {
    const init = {};
    SERVICE_ORDER.forEach((s) => (init[s] = emptyForm(s)));
    return init;
  });

  const { data: providersData } = useQuery({
    queryKey: ["service-providers"],
    queryFn: () => api.listServiceProviders(),
  });
  const providers = providersData?.providers || [];

  const createMut = useMutation({
    mutationFn: api.createServiceProvider,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["service-providers"] }),
  });
  const updateMut = useMutation({
    mutationFn: /** @param {{id: string, body: any}} vars */ (vars) => api.updateServiceProvider(vars.id, vars.body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service-providers"] });
      setEditingId(null);
    },
  });
  const deleteMut = useMutation({
    mutationFn: api.deleteServiceProvider,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["service-providers"] }),
  });

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
    setEditingId(p.id);
    setForms((prev) => ({
      ...prev,
      [p.service]: {
        service: p.service,
        name: p.name,
        credentials: { ...p.credentials },
        settings: { ...p.settings },
        enabled: p.enabled,
      },
    }));
  }

  function resetForm(service) {
    setForms((prev) => ({ ...prev, [service]: emptyForm(service) }));
    setEditingId(null);
  }

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-2">Service Providers</h2>
      <p className="text-muted-foreground mb-6">
        Configure the upstream providers that Connect uses to provision backups, email, and DNS
        for devices. These credentials are stored encrypted in the database. If no provider is
        configured for a service, Connect falls back to the values in the config file.
      </p>

      <div className="space-y-8">
        {SERVICE_ORDER.map((service) => {
          const spec = SERVICE_FIELDS[service];
          const form = forms[service];
          const items = providers.filter((p) => p.service === service);
          const isEditing = editingId !== null && items.some((p) => p.id === editingId);

          return (
            <div key={service}>
              <CardHeader className="px-0">
                <CardTitle>{spec.label}</CardTitle>
                <p className="text-sm text-muted-foreground">{spec.description}</p>
              </CardHeader>

              <div className="space-y-2 mb-4">
                {items.map((p) => (
                  <Card key={p.id} className="flex items-center justify-between animate-fade-in">
                    <div>
                      <p className="font-mono">{p.name}</p>
                      <div className="flex gap-2 mt-1">
                        {p.enabled ? (
                          <Badge variant="success">enabled</Badge>
                        ) : (
                          <Badge variant="outline">disabled</Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => startEdit(p)}
                      >
                        {isEditing && editingId === p.id ? "Cancel" : "Edit"}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        loading={deleteMut.isPending}
                        onClick={() => deleteMut.mutate(p.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </Card>
                ))}
                {items.length === 0 && (
                  <Card>
                    <p className="text-muted-foreground text-center">
                      No {spec.label.toLowerCase()} provider configured. Add one below.
                    </p>
                  </Card>
                )}
              </div>

              {(items.length === 0 || isEditing) && (
                <Card className="animate-fade-in">
                  <CardContent className="pt-6">
                    <div className="grid gap-3 md:grid-cols-2">
                      {spec.credentials.map((f) => (
                        <div key={f.key}>
                          <Label>{f.label}</Label>
                          <Input
                            type={f.type || "text"}
                            placeholder={f.placeholder}
                            value={form.credentials[f.key] || ""}
                            onChange={(e) => updateField(service, "credentials", f.key, e.target.value)}
                          />
                        </div>
                      ))}
                      {spec.settings.map((f) => (
                        <div key={f.key}>
                          <Label>{f.label}</Label>
                          <Input
                            placeholder={f.placeholder}
                            value={form.settings[f.key] || ""}
                            onChange={(e) => updateField(service, "settings", f.key, e.target.value)}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2 mt-4">
                      {isEditing ? (
                        <>
                          <Button
                            size="sm"
                            loading={updateMut.isPending}
                            onClick={() =>
                              updateMut.mutate({ id: editingId, body: form })
                            }
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
                          loading={createMut.isPending}
                          onClick={() => createMut.mutate(form)}
                        >
                          Add Provider
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          );
        })}
      </div>
    </Layout>
  );
}
