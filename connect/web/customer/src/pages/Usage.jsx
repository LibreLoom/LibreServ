import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Layout } from "../components/Layout.jsx";

const serviceLabels = {
  smtp: "Email Relay", domain: "Domain & DNS", backup: "Cloud Backup",
  tunnel: "Tunnel Access", ai: "AI Assistant", support: "Human Support",
};

export default function Usage() {
  const { data: usage } = useQuery({ queryKey: ["usage"], queryFn: api.getUsage });
  const byService = usage?.by_service || {};
  const entries = Object.entries(byService);

  return (
    <Layout>
      <h2 className="font-mono text-2xl font-bold mb-6">Usage</h2>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">Current Billing Cycle</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Start</p>
              <p className="font-mono">{usage ? new Date(usage.current_cycle_start).toLocaleDateString() : "—"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">End</p>
              <p className="font-mono">{usage ? new Date(usage.current_cycle_end).toLocaleDateString() : "—"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 mb-6">
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Total Cost</CardTitle></CardHeader>
          <CardContent>
            <p className="font-mono text-2xl font-bold">${(usage?.total_cost_usd || 0).toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Credits Used</CardTitle></CardHeader>
          <CardContent>
            <p className="font-mono text-2xl font-bold">${((usage?.credits_used || 0) / 100).toFixed(2)}</p>
          </CardContent>
        </Card>
      </div>

      <h3 className="font-mono text-lg font-bold mb-4">By Service</h3>
      {entries.length === 0 ? (
        <Card><p className="text-muted-foreground text-center">No usage recorded yet this cycle.</p></Card>
      ) : (
        <div className="space-y-3">
          {entries.map(([key, svc]) => (
            <Card key={key} className="flex items-center justify-between">
              <div>
                <p className="font-mono font-bold">{serviceLabels[key] || key}</p>
                <p className="text-sm text-muted-foreground">Usage: {svc.value.toFixed(2)}</p>
              </div>
              <div className="text-right">
                <p className="font-mono font-bold">${svc.cost_usd.toFixed(2)}</p>
                <p className="text-sm text-muted-foreground">{(svc.credits_used / 100).toFixed(2)} credits</p>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Layout>
  );
}
