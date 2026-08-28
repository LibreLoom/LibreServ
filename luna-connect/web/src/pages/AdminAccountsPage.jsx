import { useEffect, useState } from "react";
import { AdminLayout } from "../components/AdminLayout.jsx";
import { Badge, StatusBadge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { adminApi } from "../context/AdminAuthContext.jsx";

function formatWhen(unix) {
  if (!unix) return "—";
  try {
    return new Date(Number(unix) * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

export default function AdminAccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi("/admin/accounts")
      .then((data) => setAccounts(data.accounts || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <AdminLayout>
      <h2 className="font-mono text-2xl mb-2">Accounts</h2>
      <p className="text-muted-foreground mb-6">Customer Luna Connect sign-ins.</p>
      <Card>
        <CardHeader>
          <CardTitle>Customers</CardTitle>
          <CardDescription>{accounts.length} account{accounts.length === 1 ? "" : "s"}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading accounts…</p>
          ) : error ? (
            <p className="text-sm text-error">{error}</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No customer accounts yet.</p>
          ) : (
            <ul className="space-y-3">
              {accounts.map((a) => (
                <li
                  key={a.id}
                  className="rounded-large-element border border-border px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-mono text-sm break-all">{a.email}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {a.device_count} device{a.device_count === 1 ? "" : "s"} · created {formatWhen(a.created_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={a.has_card ? "success" : "outline"}>
                      {a.has_card ? "Card on file" : "No card"}
                    </Badge>
                    <StatusBadge status={a.billing_status || "none"} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </AdminLayout>
  );
}
