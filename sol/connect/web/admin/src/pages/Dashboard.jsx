import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Layout } from "../components/Layout.jsx";

export default function Dashboard() {
  const { data: usage, isLoading: usageLoading } = useQuery({ queryKey: ["aggregated-usage"], queryFn: api.getAggregatedUsage });
  const { data: devices, isLoading: devicesLoading } = useQuery({ queryKey: ["devices"], queryFn: api.listDevices });

  // Don't render dashboard content until all queries resolve — otherwise the
  // page flashes zero values before the data arrives.
  const dashboardLoading = usageLoading || devicesLoading;

  const deviceCount = devices?.devices?.length || 0;
  const activeDevices = (devices?.devices || []).filter((d) => d.is_active).length;
  const totalCost = usage?.usage?.total_cost || 0;

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-6">Dashboard</h2>

      {dashboardLoading ? (
        <div className="flex flex-col items-center justify-center py-24">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mb-4" />
          <p className="font-mono text-sm text-muted-foreground">Loading dashboard…</p>
        </div>
      ) : (
      <>
      <div className="grid gap-4 md:grid-cols-3 mb-8">
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Total Devices</CardTitle></CardHeader>
          <CardContent><p className="font-mono text-2xl">{deviceCount}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Active Devices</CardTitle></CardHeader>
          <CardContent><p className="font-mono text-2xl">{activeDevices}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Monthly Cost</CardTitle></CardHeader>
          <CardContent><p className="font-mono text-2xl">${totalCost.toFixed(2)}</p></CardContent>
        </Card>
      </div>

      <h3 className="font-mono text-lg mb-4">Usage by Service</h3>
      <div className="grid gap-3 md:grid-cols-3">
        {["smtp", "backup", "tunnel", "ai", "domain", "support"].map((svc) => {
          const cost = usage?.usage?.[`${svc}_cost`] || 0;
          return (
            <Card key={svc}>
              <CardHeader><CardTitle className="text-sm text-muted-foreground capitalize">{svc}</CardTitle></CardHeader>
              <CardContent><p className="font-mono text-lg">${cost.toFixed(2)}</p></CardContent>
            </Card>
          );
        })}
      </div>
      </>
      )}
    </Layout>
  );
}
