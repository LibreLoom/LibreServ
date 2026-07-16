import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Layout } from "../components/Layout.jsx";

export default function Dashboard() {
  const { data: usage } = useQuery({ queryKey: ["aggregated-usage"], queryFn: api.getAggregatedUsage });
  const { data: devices } = useQuery({ queryKey: ["devices"], queryFn: api.listDevices });
  const { data: fleet } = useQuery({ queryKey: ["fleet"], queryFn: api.getFleetStatus });

  const deviceCount = devices?.devices?.length || 0;
  const activeDevices = (devices?.devices || []).filter((d) => d.is_active).length;
  const totalCost = usage?.usage?.total_cost || 0;

  return (
    <Layout>
      <h2 className="font-mono text-2xl font-bold mb-6">Dashboard</h2>

      <div className="grid gap-4 md:grid-cols-4 mb-8">
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Total Devices</CardTitle></CardHeader>
          <CardContent><p className="font-mono text-2xl font-bold">{deviceCount}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Active Devices</CardTitle></CardHeader>
          <CardContent><p className="font-mono text-2xl font-bold">{activeDevices}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Monthly Cost</CardTitle></CardHeader>
          <CardContent><p className="font-mono text-2xl font-bold">${totalCost.toFixed(2)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Relay Nodes</CardTitle></CardHeader>
          <CardContent><p className="font-mono text-2xl font-bold">{fleet?.healthy_nodes || 0}/{fleet?.total_nodes || 0}</p></CardContent>
        </Card>
      </div>

      <h3 className="font-mono text-lg font-bold mb-4">Usage by Service</h3>
      <div className="grid gap-3 md:grid-cols-3">
        {["smtp", "backup", "tunnel", "ai", "domain", "support"].map((svc) => {
          const cost = usage?.usage?.[`${svc}_cost`] || 0;
          return (
            <Card key={svc}>
              <CardHeader><CardTitle className="text-sm text-muted-foreground capitalize">{svc}</CardTitle></CardHeader>
              <CardContent><p className="font-mono text-lg font-bold">${cost.toFixed(2)}</p></CardContent>
            </Card>
          );
        })}
      </div>
    </Layout>
  );
}
