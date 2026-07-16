import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";

export default function Dashboard() {
  const { device } = useAuth();
  const { data: usage } = useQuery({
    queryKey: ["usage"],
    queryFn: api.getUsage,
  });

  const services = [
    { key: "smtp", label: "Email Relay" },
    { key: "domain", label: "Domain & DNS" },
    { key: "backup", label: "Cloud Backup" },
    { key: "tunnel", label: "Tunnel Access" },
    { key: "ai", label: "AI Assistant" },
    { key: "support", label: "Human Support" },
  ];

  return (
    <Layout>
      <h2 className="font-mono text-2xl font-bold mb-6">Dashboard</h2>

      <div className="grid gap-4 md:grid-cols-2 mb-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Your Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-xl font-bold">{device?.plan_name || "—"}</p>
            {device && <Badge variant="success">Active</Badge>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">This Billing Cycle</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-xl font-bold">
              ${(usage?.total_cost_usd || 0).toFixed(2)}
            </p>
            <p className="text-sm text-muted-foreground">
              ${((usage?.credits_used || 0) / 100).toFixed(2)} credits used
            </p>
          </CardContent>
        </Card>
      </div>

      <h3 className="font-mono text-lg font-bold mb-4">Services</h3>
      <div className="grid gap-3 md:grid-cols-2">
        {services.map((svc) => {
          const svcUsage = usage?.by_service?.[svc.key];
          return (
            <Card key={svc.key} className="flex items-center justify-between">
              <span className="font-mono">{svc.label}</span>
              {svcUsage ? (
                <Badge variant="success">Active</Badge>
              ) : (
                <Badge variant="outline">Not configured</Badge>
              )}
            </Card>
          );
        })}
      </div>
    </Layout>
  );
}
