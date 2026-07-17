import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Badge, StatusBadge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";

export default function Relay() {
  const queryClient = useQueryClient();
  const { data: fleet } = useQuery({ queryKey: ["fleet"], queryFn: api.getFleetStatus });
  const { data: regions } = useQuery({ queryKey: ["regions"], queryFn: api.listRegions });

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", provider: "", region: "", host: "", capacity_gb: 0, is_premium: true });

  const createMut = useMutation({
    mutationFn: api.createRegion,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["regions"] }); queryClient.invalidateQueries({ queryKey: ["fleet"] }); setShowForm(false); setForm({ name: "", provider: "", region: "", host: "", capacity_gb: 0, is_premium: true }); },
  });
  const healthMut = useMutation({
    mutationFn: /** @param {{id: string, isHealthy: boolean}} vars */ (vars) => api.updateRegionHealth(vars.id, vars.isHealthy),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["regions"] }); queryClient.invalidateQueries({ queryKey: ["fleet"] }); },
  });
  const deleteMut = useMutation({
    mutationFn: api.deleteRegion,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["regions"] }); queryClient.invalidateQueries({ queryKey: ["fleet"] }); },
  });

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-2">Relay Fleet</h2>
      <p className="text-muted-foreground mb-6">
        Tunnel relay nodes provide encrypted public access to LibreServ devices.
        Premium relays (Hetzner/Akamai) serve paid plans; non-premium relays serve the free tier.
      </p>

      {fleet && (
        <div className="grid gap-4 md:grid-cols-4 mb-8">
          <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Total Nodes</CardTitle></CardHeader><CardContent><p className="font-mono text-2xl">{fleet.total_nodes}</p></CardContent></Card>
          <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Healthy</CardTitle></CardHeader><CardContent><p className="font-mono text-2xl">{fleet.healthy_nodes}</p></CardContent></Card>
          <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Premium</CardTitle></CardHeader><CardContent><p className="font-mono text-2xl">{fleet.premium_nodes}</p></CardContent></Card>
          <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Capacity</CardTitle></CardHeader><CardContent><p className="font-mono text-2xl">{fleet.total_capacity_gb} GB</p></CardContent></Card>
        </div>
      )}

      <Button size="sm" className="mb-4" onClick={() => setShowForm(!showForm)}>
        {showForm ? "Cancel" : "Add Region"}
      </Button>

      {showForm && (
        <Card className="mb-4 animate-fade-in">
          <CardContent className="pt-6">
            <div className="grid gap-3 md:grid-cols-2">
              <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div><Label>Provider</Label><Input value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} /></div>
              <div><Label>Region</Label><Input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></div>
              <div><Label>Host</Label><Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></div>
              <div><Label>Capacity (GB)</Label><Input type="number" value={form.capacity_gb} onChange={(e) => setForm({ ...form, capacity_gb: parseInt(e.target.value) })} /></div>
              <label className="flex items-center gap-2 pt-8">
                <input type="checkbox" checked={form.is_premium} onChange={(e) => setForm({ ...form, is_premium: e.target.checked })} />
                <span className="font-mono text-sm">Premium relay</span>
              </label>
            </div>
            <Button className="mt-3" size="sm" loading={createMut.isPending} onClick={() => createMut.mutate(form)}>Create</Button>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {(regions?.regions || []).map((r) => (
          <Card key={r.id} className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <p className="font-mono">{r.name}</p>
                <Badge variant={r.is_premium ? "info" : "default"}>{r.is_premium ? "premium" : "free"}</Badge>
                <StatusBadge status={r.is_healthy ? "healthy" : "unhealthy"} />
              </div>
              <p className="text-sm text-muted-foreground">{r.provider} · {r.region} · {r.host}</p>
              <p className="text-sm text-muted-foreground">{r.used_gb.toFixed(1)} / {r.capacity_gb} GB used</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" loading={healthMut.isPending} onClick={() => healthMut.mutate({ id: r.id, isHealthy: !r.is_healthy })}>
                {r.is_healthy ? "Mark Unhealthy" : "Mark Healthy"}
              </Button>
              <Button variant="destructive" size="sm" loading={deleteMut.isPending} onClick={() => deleteMut.mutate(r.id)}>Delete</Button>
            </div>
          </Card>
        ))}
        {(!regions?.regions || regions.regions.length === 0) && (
          <Card><p className="text-muted-foreground text-center">No relay regions configured.</p></Card>
        )}
      </div>
    </Layout>
  );
}
