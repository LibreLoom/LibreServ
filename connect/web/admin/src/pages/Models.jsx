import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Separator } from "../components/ui/separator.jsx";
import { Layout } from "../components/Layout.jsx";

export default function Models() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("providers");

  const { data: providers } = useQuery({ queryKey: ["providers"], queryFn: api.listProviders });
  const { data: models } = useQuery({ queryKey: ["models"], queryFn: () => api.listModels() });

  const [showProviderForm, setShowProviderForm] = useState(false);
  const [providerForm, setProviderForm] = useState({ name: "", base_url: "", api_key: "", tier: "paid", enabled: true });

  const createProviderMut = useMutation({
    mutationFn: api.createProvider,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["providers"] }); setShowProviderForm(false); setProviderForm({ name: "", base_url: "", api_key: "", tier: "paid", enabled: true }); },
  });
  const deleteProviderMut = useMutation({
    mutationFn: api.deleteProvider,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  });

  const [showModelForm, setShowModelForm] = useState(false);
  const [modelForm, setModelForm] = useState({
    provider_id: "", model_id: "", display_name: "", role: "agent",
    input_price_per_million: 0, output_price_per_million: 0, cache_price_per_million: 0,
    context_window: 0, enabled: true, sort_order: 0,
  });

  const createModelMut = useMutation({
    mutationFn: api.createModel,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["models"] }); setShowModelForm(false); },
  });
  const deleteModelMut = useMutation({
    mutationFn: api.deleteModel,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["models"] }),
  });

  return (
    <Layout>
      <h2 className="font-mono text-2xl font-bold mb-2">AI Models</h2>
      <p className="text-muted-foreground mb-6">
        Configure AI inference providers and models. No provider URLs are hardcoded — all are loaded from the database.
        Free-tier models are configured separately from paid models.
      </p>

      <div className="flex gap-2 mb-6">
        <Button variant={tab === "providers" ? "default" : "outline"} size="sm" onClick={() => setTab("providers")}>Providers</Button>
        <Button variant={tab === "models" ? "default" : "outline"} size="sm" onClick={() => setTab("models")}>Models</Button>
      </div>

      {tab === "providers" && (
        <div>
          <Button size="sm" className="mb-4" onClick={() => setShowProviderForm(!showProviderForm)}>
            {showProviderForm ? "Cancel" : "Add Provider"}
          </Button>

          {showProviderForm && (
            <Card className="mb-4 animate-fade-in">
              <CardContent className="pt-6">
                <div className="grid gap-3 md:grid-cols-2">
                  <div><Label>Name</Label><Input value={providerForm.name} onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })} /></div>
                  <div><Label>Base URL</Label><Input value={providerForm.base_url} onChange={(e) => setProviderForm({ ...providerForm, base_url: e.target.value })} /></div>
                  <div><Label>API Key</Label><Input type="password" value={providerForm.api_key} onChange={(e) => setProviderForm({ ...providerForm, api_key: e.target.value })} /></div>
                  <div><Label>Tier</Label><Input value={providerForm.tier} onChange={(e) => setProviderForm({ ...providerForm, tier: e.target.value })} /></div>
                </div>
                <Button className="mt-3" size="sm" loading={createProviderMut.isPending} onClick={() => createProviderMut.mutate(providerForm)}>Create</Button>
              </CardContent>
            </Card>
          )}

          <div className="space-y-2">
            {(providers?.providers || []).map((p) => (
              <Card key={p.id} className="flex items-center justify-between">
                <div>
                  <p className="font-mono font-bold">{p.name}</p>
                  <p className="text-sm text-muted-foreground">{p.base_url}</p>
                  <div className="flex gap-2 mt-1">
                    <Badge variant={p.tier === "free" ? "info" : "default"}>{p.tier}</Badge>
                    {p.enabled ? <Badge variant="success">enabled</Badge> : <Badge variant="outline">disabled</Badge>}
                  </div>
                </div>
                <Button variant="destructive" size="sm" loading={deleteProviderMut.isPending} onClick={() => deleteProviderMut.mutate(p.id)}>Delete</Button>
              </Card>
            ))}
            {(!providers?.providers || providers.providers.length === 0) && (
              <Card><p className="text-muted-foreground text-center">No providers configured.</p></Card>
            )}
          </div>
        </div>
      )}

      {tab === "models" && (
        <div>
          <Button size="sm" className="mb-4" onClick={() => setShowModelForm(!showModelForm)}>
            {showModelForm ? "Cancel" : "Add Model"}
          </Button>

          {showModelForm && (
            <Card className="mb-4 animate-fade-in">
              <CardContent className="pt-6">
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <Label>Provider</Label>
                    <select
                      className="flex h-10 w-full rounded-pill border border-input bg-background px-4 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:border-ring"
                      value={modelForm.provider_id}
                      onChange={(e) => setModelForm({ ...modelForm, provider_id: e.target.value })}
                    >
                      <option value="">Select provider...</option>
                      {(providers?.providers || []).map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                  <div><Label>Model ID</Label><Input value={modelForm.model_id} onChange={(e) => setModelForm({ ...modelForm, model_id: e.target.value })} /></div>
                  <div><Label>Display Name</Label><Input value={modelForm.display_name} onChange={(e) => setModelForm({ ...modelForm, display_name: e.target.value })} /></div>
                  <div><Label>Role</Label><Input value={modelForm.role} onChange={(e) => setModelForm({ ...modelForm, role: e.target.value })} /></div>
                  <div><Label>Input $/M tokens</Label><Input type="number" step="0.01" value={modelForm.input_price_per_million} onChange={(e) => setModelForm({ ...modelForm, input_price_per_million: parseFloat(e.target.value) })} /></div>
                  <div><Label>Output $/M tokens</Label><Input type="number" step="0.01" value={modelForm.output_price_per_million} onChange={(e) => setModelForm({ ...modelForm, output_price_per_million: parseFloat(e.target.value) })} /></div>
                  <div><Label>Context Window</Label><Input type="number" value={modelForm.context_window} onChange={(e) => setModelForm({ ...modelForm, context_window: parseInt(e.target.value) })} /></div>
                </div>
                <Button className="mt-3" size="sm" loading={createModelMut.isPending} onClick={() => createModelMut.mutate(modelForm)}>Create</Button>
              </CardContent>
            </Card>
          )}

          <div className="space-y-2">
            {(models?.models || []).map((m) => (
              <Card key={m.id} className="flex items-center justify-between">
                <div>
                  <p className="font-mono font-bold">{m.display_name}</p>
                  <p className="text-sm text-muted-foreground">{m.model_id} · {m.role}</p>
                  <p className="text-sm text-muted-foreground">In: ${m.input_price_per_million}/M · Out: ${m.output_price_per_million}/M</p>
                </div>
                <Button variant="destructive" size="sm" loading={deleteModelMut.isPending} onClick={() => deleteModelMut.mutate(m.id)}>Delete</Button>
              </Card>
            ))}
            {(!models?.models || models.models.length === 0) && (
              <Card><p className="text-muted-foreground text-center">No models configured.</p></Card>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}
