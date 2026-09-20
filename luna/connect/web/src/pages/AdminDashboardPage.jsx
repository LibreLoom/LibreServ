import { useEffect, useState } from "react";
import { AdminLayout } from "../components/AdminLayout.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { adminApi } from "../context/AdminAuthContext.jsx";

function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function AdminDashboardPage() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi("/admin/stats")
      .then(setStats)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const boundCount = stats
    ? Math.max(0, Number(stats.devices || 0) - Number(stats.tokens_unclaimed || 0) - Number(stats.tokens_revoked || 0))
    : 0;

  return (
    <AdminLayout>
      <h2 className="font-mono text-2xl mb-6">Dashboard</h2>
      {loading ? (
        <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading dashboard…</p>
      ) : error ? (
        <p className="text-sm text-error">{error}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">Accounts</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-2xl">{stats.accounts}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">Device tokens</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-2xl">{stats.devices}</p>
              <p className="font-mono text-xs text-muted-foreground mt-1">
                {stats.tokens_unclaimed} unused · {boundCount} bound
                {stats.tokens_revoked > 0 ? ` · ${stats.tokens_revoked} revoked` : ""}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">Cloud backup stored</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-2xl">{formatBytes(stats.backup_bytes)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">Est. backup month</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-2xl">${Number(stats.estimated_month || 0).toFixed(2)}</p>
              <p className="font-mono text-xs text-muted-foreground mt-1">$8 per TB stored</p>
            </CardContent>
          </Card>
        </div>
      )}
    </AdminLayout>
  );
}
