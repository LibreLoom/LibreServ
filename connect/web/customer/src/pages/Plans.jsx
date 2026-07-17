import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";
import { useAuth } from "../context/AuthContext.jsx";

export default function Plans() {
  const { device, refreshDevice } = useAuth();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["plans"], queryFn: api.getPlans });

  const subscribeMut = useMutation({
    mutationFn: api.subscribe,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["plans"] }); refreshDevice(); },
  });
  const changePlanMut = useMutation({
    mutationFn: api.changePlan,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["plans"] }); refreshDevice(); },
  });

  const currentPlanId = device?.plan_id;

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-2">Plans</h2>
      <p className="text-muted-foreground mb-8">
        Choose the plan that fits your needs. You can change or cancel at any time.
        Overage is charged at our actual cost — no hidden markups.
      </p>

      <div className="grid gap-4 md:grid-cols-3">
        {(data?.plans || []).map((plan) => {
          const isCurrent = plan.id === currentPlanId;
          const limits = plan.limits || {};
          return (
            <Card key={plan.id} className={isCurrent ? "ring-2 ring-ring" : ""}>
              <CardHeader>
                <CardTitle>{plan.name}</CardTitle>
                <p className="text-sm text-muted-foreground">{plan.description}</p>
              </CardHeader>
              <CardContent>
                <p className="font-mono text-3xl mb-4">
                  ${plan.price_monthly / 100}
                  <span className="text-sm text-muted-foreground font-sans">/month</span>
                </p>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li>Backup: {limits.backup_gb || 0} GB</li>
                  <li>AI credit: ${((limits.ai_credit_cents || 0) / 100).toFixed(2)}/month</li>
                  <li>Tunnel: {limits.tunnel_gb || 0} GB</li>
                  <li>Email: {limits.smtp_monthly || 0}/month</li>
                  <li>Human support: {limits.human_support ? "Included" : "Not included"}</li>
                </ul>
              </CardContent>
              <CardFooter>
                {isCurrent ? (
                  <Button variant="outline" className="w-full" disabled>Current Plan</Button>
                ) : currentPlanId ? (
                  <Button
                    className="w-full"
                    loading={changePlanMut.isPending}
                    onClick={() => changePlanMut.mutate(plan.id)}
                  >
                    Switch to {plan.name}
                  </Button>
                ) : (
                  <Button
                    className="w-full"
                    loading={subscribeMut.isPending}
                    onClick={() => subscribeMut.mutate(plan.id)}
                  >
                    Subscribe
                  </Button>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </Layout>
  );
}
