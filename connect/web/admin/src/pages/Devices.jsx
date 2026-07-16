import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { StatusBadge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";

export default function Devices() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["devices"], queryFn: api.listDevices });
  const [selectedId, setSelectedId] = useState(null);

  const { data: device } = useQuery({
    queryKey: ["device", selectedId],
    queryFn: () => api.getDevice(selectedId),
    enabled: !!selectedId,
  });
  const { data: deviceUsage } = useQuery({
    queryKey: ["device-usage", selectedId],
    queryFn: () => api.getDeviceUsage(selectedId),
    enabled: !!selectedId,
  });

  const rotateMut = useMutation({
    mutationFn: /** @param {{id: string, service: string}} vars */ (vars) => api.rotateCredentials(vars.id, vars.service),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["devices"] }),
  });

  return (
    <Layout>
      <h2 className="font-mono text-2xl font-bold mb-6">Devices</h2>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          {(data?.devices || []).map((d) => (
            <Card
              key={d.id}
              className={`cursor-pointer transition-all hover:scale-[1.01] ${selectedId === d.id ? "ring-2 ring-ring" : ""}`}
              onClick={() => setSelectedId(d.id)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm font-bold">{d.id}</p>
                  <p className="text-sm text-muted-foreground">{d.plan_id}</p>
                </div>
                <StatusBadge status={d.is_active ? "active" : "inactive"} />
              </div>
            </Card>
          ))}
          {(!data?.devices || data.devices.length === 0) && (
            <Card><p className="text-muted-foreground text-center">No devices registered.</p></Card>
          )}
        </div>

        {selectedId && device && (
          <Card className="animate-fade-in">
            <CardHeader><CardTitle>Device Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">ID</dt>
                  <dd className="font-mono">{device.id}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Plan</dt>
                  <dd className="font-mono">{device.plan_id}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Activated</dt>
                  <dd className="font-mono">{new Date(device.activated_at).toLocaleString()}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Last Seen</dt>
                  <dd className="font-mono">{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : "—"}</dd>
                </div>
              </dl>

              {deviceUsage && (
                <div className="mt-4 pt-4 border-t border-border">
                  <p className="font-mono text-sm text-muted-foreground mb-2">Usage This Cycle</p>
                  <p className="font-mono text-lg font-bold">${(deviceUsage.total_cost_usd || 0).toFixed(2)}</p>
                </div>
              )}

              <div className="mt-4 pt-4 border-t border-border">
                <p className="font-mono text-sm text-muted-foreground mb-2">Rotate Credentials</p>
                <div className="flex flex-wrap gap-2">
                  {["smtp", "domain", "backup", "tunnel", "ai"].map((svc) => (
                    <Button
                      key={svc}
                      variant="outline"
                      size="sm"
                      loading={rotateMut.isPending}
                      onClick={() => rotateMut.mutate({ id: selectedId, service: svc })}
                    >
                      {svc}
                    </Button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
