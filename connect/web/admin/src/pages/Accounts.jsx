import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "../components/ui/card.jsx";
import { Badge, StatusBadge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";
import { Users, MailCheck, Shield } from "lucide-react";

export default function Accounts() {
  const [selectedId, setSelectedId] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["customer-accounts"],
    queryFn: api.listCustomerAccounts,
  });

  const { data: detail } = useQuery({
    queryKey: ["customer-account", selectedId],
    queryFn: () => api.getCustomerAccount(selectedId),
    enabled: !!selectedId,
  });

  const accounts = data?.accounts || [];

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-2">Accounts</h2>
      <p className="text-muted-foreground mb-6">
        Customer portal sign-ins. Open an account to see linked devices and Connect keys.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4" /> Customers
            </CardTitle>
            <CardDescription>{accounts.length} account{accounts.length === 1 ? "" : "s"}</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading accounts…</p>
            ) : error ? (
              <p className="text-sm text-destructive">{error.message}</p>
            ) : accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No customer accounts yet.</p>
            ) : (
              <ul className="space-y-2">
                {accounts.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(a.id)}
                      className={`w-full text-left rounded-large-element border border-border px-4 py-3 transition-colors hover:bg-accent/30 ${
                        selectedId === a.id ? "ring-2 ring-ring" : ""
                      }`}
                    >
                      <p className="font-mono text-sm break-all">{a.email}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {a.plan_name} · {a.device_count} device{a.device_count === 1 ? "" : "s"} ·{" "}
                        {new Date(a.created_at).toLocaleDateString()}
                      </p>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {a.email_verified ? (
                          <Badge variant="success">Email verified</Badge>
                        ) : (
                          <Badge variant="warning">Email not verified</Badge>
                        )}
                        {a.has_2fa && <Badge variant="success">2FA</Badge>}
                        {!a.is_active && <Badge variant="outline">Disabled</Badge>}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {selectedId && detail && (
          <Card className="animate-fade-in">
            <CardHeader>
              <CardTitle>Account details</CardTitle>
              <CardDescription className="font-mono break-all">{detail.email}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Plan</dt>
                  <dd className="font-mono">{detail.plan_name}</dd>
                </div>
                {detail.name && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Name</dt>
                    <dd>{detail.name}</dd>
                  </div>
                )}
                {detail.username && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Email username</dt>
                    <dd className="font-mono">{detail.username}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Created</dt>
                  <dd className="font-mono">{new Date(detail.created_at).toLocaleString()}</dd>
                </div>
              </dl>

              <section>
                <h3 className="font-mono text-sm mb-2 flex items-center gap-2">
                  <Shield className="h-4 w-4" /> Devices
                </h3>
                {(detail.devices || []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No devices linked.</p>
                ) : (
                  <ul className="space-y-2">
                    {detail.devices.map((d) => (
                      <li key={d.id} className="rounded-large-element border border-border px-3 py-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono truncate">{d.subdomain || d.id}</span>
                          <StatusBadge status={d.is_active ? "active" : "inactive"} />
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{d.plan_name}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="font-mono text-sm mb-2 flex items-center gap-2">
                  <MailCheck className="h-4 w-4" /> Connect keys
                </h3>
                {(detail.connect_keys || []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No Connect keys on file.</p>
                ) : (
                  <ul className="space-y-2">
                    {detail.connect_keys.map((k) => (
                      <li key={k.id} className="rounded-large-element border border-border px-3 py-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono">{k.key_prefix}</span>
                          <StatusBadge status={k.status} />
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{k.plan_name}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
