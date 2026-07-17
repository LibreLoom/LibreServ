import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input, Textarea } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Layout } from "../components/Layout.jsx";

export default function Plans() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["plans"], queryFn: api.listPlans });
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: "", description: "", price_monthly: 0, limits_json: "{}" });

  const updateMut = useMutation({
    mutationFn: /** @param {{id: string, body: any}} vars */ (vars) => api.updatePlan(vars.id, vars.body),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["plans"] }); setEditing(null); },
  });

  const startEdit = (plan) => {
    setEditing(plan.id);
    setForm({
      name: plan.name,
      description: plan.description,
      price_monthly: plan.price_monthly,
      limits_json: typeof plan.limits === "string" ? plan.limits : JSON.stringify(plan.limits, null, 2),
    });
  };

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-2">Plans</h2>
      <p className="text-muted-foreground mb-6">View and edit subscription plan definitions. Changes take effect immediately.</p>

      <div className="grid gap-4 md:grid-cols-3">
        {(data?.plans || []).map((plan) => (
          <Card key={plan.id}>
            {editing === plan.id ? (
              <CardContent className="pt-6">
                <div className="space-y-3">
                  <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                  <div><Label>Description</Label><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
                  <div><Label>Price (cents)</Label><Input type="number" value={form.price_monthly} onChange={(e) => setForm({ ...form, price_monthly: parseInt(e.target.value) })} /></div>
                  <div><Label>Limits JSON</Label><Textarea rows={6} value={form.limits_json} onChange={(e) => setForm({ ...form, limits_json: e.target.value })} /></div>
                  <div className="flex gap-2">
                    <Button size="sm" loading={updateMut.isPending} onClick={() => updateMut.mutate({ id: plan.id, body: form })}>Save</Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              </CardContent>
            ) : (
              <>
                <CardHeader>
                  <CardTitle>{plan.name}</CardTitle>
                  <p className="text-sm text-muted-foreground">{plan.description}</p>
                </CardHeader>
                <CardContent>
                  <p className="font-mono text-2xl mb-3">${plan.price_monthly / 100}/mo</p>
                </CardContent>
                <CardFooter>
                  <Button variant="outline" size="sm" onClick={() => startEdit(plan)}>Edit</Button>
                </CardFooter>
              </>
            )}
          </Card>
        ))}
      </div>
    </Layout>
  );
}
