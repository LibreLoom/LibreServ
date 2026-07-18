import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { StatusBadge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";

export default function Tunnels() {
  const { data, isLoading } = useQuery({
    queryKey: ["tunnels"],
    queryFn: api.listTunnels,
  });

  const tunnels = data?.tunnels || [];

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-6">Tunnels</h2>

      {isLoading && (
        <Card>
          <CardContent className="py-8">
            <p className="text-muted-foreground text-center">Loading tunnels…</p>
          </CardContent>
        </Card>
      )}

      {!isLoading && tunnels.length === 0 && (
        <Card>
          <CardContent className="py-8">
            <p className="text-muted-foreground text-center">No tunnels provisioned.</p>
          </CardContent>
        </Card>
      )}

      {!isLoading && tunnels.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {tunnels.map((t) => (
            <Card key={t.id} className="animate-fade-in">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {t.tunnel_name || "Unnamed tunnel"}
                  <StatusBadge status={t.is_active ? "active" : "inactive"} />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground font-mono">Device:</span>
                  <span className="font-mono">{t.device_name || t.device_id}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground font-mono">ID:</span>
                  <span className="font-mono text-xs">{t.id}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground font-mono">Provisioned:</span>
                  <span className="font-mono">{t.provisioned_at}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </Layout>
  );
}
