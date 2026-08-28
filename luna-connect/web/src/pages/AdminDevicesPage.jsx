import { useEffect, useState } from "react";
import { AdminLayout } from "../components/AdminLayout.jsx";
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

export default function AdminDevicesPage() {
  const [devices, setDevices] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi("/admin/devices")
      .then((data) => setDevices(data.devices || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <AdminLayout>
      <h2 className="font-mono text-2xl mb-2">Devices</h2>
      <p className="text-muted-foreground mb-6">Every Luna paired through this Connect.</p>
      {loading ? (
        <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading devices…</p>
      ) : error ? (
        <p className="text-sm text-error">{error}</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-5">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>List</CardTitle>
              <CardDescription>{devices.length} device{devices.length === 1 ? "" : "s"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 max-h-[32rem] overflow-auto">
              {devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">No devices yet.</p>
              ) : (
                devices.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setSelected(d)}
                    className={`w-full text-left rounded-large-element border px-4 py-3 transition-colors ${
                      selected?.id === d.id
                        ? "border-foreground bg-accent"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    <p className="font-mono text-sm break-all">{d.hostname || d.subdomain}</p>
                    <p className="text-xs text-muted-foreground mt-1">{d.account_email || "No account linked"}</p>
                  </button>
                ))
              )}
            </CardContent>
          </Card>
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle>Detail</CardTitle>
              <CardDescription>
                {selected ? "Selected device" : "Choose a device from the list"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!selected ? (
                <p className="text-sm text-muted-foreground">Nothing selected.</p>
              ) : (
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Name</dt>
                    <dd className="font-mono text-right">{selected.name || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Address</dt>
                    <dd className="font-mono text-right break-all">{selected.hostname}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Account</dt>
                    <dd className="font-mono text-right break-all">{selected.account_email || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Device id</dt>
                    <dd className="font-mono text-right break-all">{selected.id}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Account id</dt>
                    <dd className="font-mono text-right break-all">{selected.account_id || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Created</dt>
                    <dd className="font-mono text-right">{formatWhen(selected.created_at)}</dd>
                  </div>
                </dl>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </AdminLayout>
  );
}
