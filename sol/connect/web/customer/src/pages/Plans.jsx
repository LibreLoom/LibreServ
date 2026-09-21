import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { Loader2, AlertCircle, Check } from "lucide-react";

/**
 * Plans — choose or change your Connect plan. Prices are monthly; overage
 * beyond included allowances is charged at our actual cost, no markup.
 */
export default function Plans() {
  const { account } = useAuth();
  const queryClient = useQueryClient();
  const { data, isLoading, error: loadError } = useQuery({ queryKey: ["plans"], queryFn: api.getPlans });
  const { data: devicesData } = useQuery({ queryKey: ["devices"], queryFn: api.getDevices });

  const devices = (devicesData?.devices || []).filter((d) => d.is_active);
  // The device currently serving this account, for showing its real address
  // on the current plan card instead of the plan's wildcard.
  const currentDomain = devices[0]?.current_domain || "";

  const goCheckout = async (planId, fn) => {
    const res = await fn(planId);
    if (res.checkout_url && res.checkout_url !== "#") {
      window.location.href = res.checkout_url;
    }
    return res;
  };

  const subscribeMut = useMutation({
    mutationFn: (planId) => goCheckout(planId, api.createCheckout),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["plans"] }); queryClient.invalidateQueries({ queryKey: ["devices"] }); },
  });
  const changePlanMut = useMutation({
    mutationFn: (planId) => goCheckout(planId, api.changePlan),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["plans"] }); queryClient.invalidateQueries({ queryKey: ["devices"] }); },
  });

  const currentPlanId = account?.plan_id || devices[0]?.plan_id;
  const busy = subscribeMut.isPending || changePlanMut.isPending;
  const actionError = subscribeMut.error?.message || changePlanMut.error?.message;

  return (
    <Layout>
      <div className="max-w-4xl mx-auto">
        <h1 className="font-mono text-xl mb-1.5">Plans</h1>
        <p className="text-sm text-muted-foreground mb-8 max-w-[60ch]">
          Change or cancel anytime. Usage beyond included allowances is billed
          at our actual cost — never marked up.
        </p>

        {loadError && (
          <p className="flex items-center gap-1.5 text-sm text-error mb-6">
            <AlertCircle className="w-4 h-4" /> Couldn't load plans. {loadError.message}
          </p>
        )}

        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-3 animate-pulse">
            {[0, 1, 2].map((i) => <div key={i} className="h-72 rounded-large-element bg-accent" />)}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {(data?.plans || []).map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                isCurrent={plan.id === currentPlanId}
                busy={busy}
                currentDomain={currentDomain}
                onSelect={() => (currentPlanId ? changePlanMut.mutate(plan.id) : subscribeMut.mutate(plan.id))}
              />
            ))}
          </div>
        )}

        {actionError && (
          <p className="flex items-center gap-1.5 text-sm text-error mt-4">
            <AlertCircle className="w-4 h-4" /> {actionError}
          </p>
        )}
      </div>
    </Layout>
  );
}

function PlanCard({ plan, isCurrent, busy, onSelect, currentDomain }) {
  const limits = plan.limits || {};
  const freeAI = limits.ai_messages_per_day > 0;

  const domainValue = isCurrent && currentDomain
    ? <span className="text-secondary-foreground">{currentDomain}</span>
    : plan.limits?.domain ? plan.limits.domain.replace("*", "you") : "—";

  return (
    <Card className={isCurrent ? "ring-2 ring-ring" : ""}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{plan.name}</CardTitle>
          {isCurrent && <Badge variant="info">Current</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">{plan.description}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="font-mono text-3xl leading-none">
          ${(plan.price_monthly / 100).toFixed(0)}
          <span className="text-sm text-muted-foreground font-sans">/mo</span>
        </p>
        <dl className="space-y-1.5 text-sm">
          <PlanLimit label="Backup storage" value={limits.backup_gb > 0 ? `${limits.backup_gb} GB` : "—"} />
          <PlanLimit
            label="AI assistant"
            value={
              freeAI
                ? `${limits.ai_messages_per_day} msgs/day`
                : limits.ai_credit_cents > 0
                  ? `$${(limits.ai_credit_cents / 100).toFixed(2)} credit/mo`
                  : "—"
            }
          />
          <PlanLimit label="Email" value={limits.smtp_monthly > 0 ? `${limits.smtp_monthly}/month` : "—"} />
          <PlanLimit label="Tunnel bandwidth" value={limits.tunnel_gb_per_mo > 0 ? `${limits.tunnel_gb_per_mo} GB/mo` : "Unlimited"} />
          <PlanLimit label="Domain & DNS" value={domainValue} />
          <PlanLimit
            label="Human support"
            value={limits.human_support ? <Check className="w-4 h-4 text-success" /> : "—"}
          />
        </dl>
      </CardContent>
      <CardFooter>
        {isCurrent ? (
          <Button variant="outline" className="w-full" disabled>Current plan</Button>
        ) : (
          <Button className="w-full" loading={busy} onClick={onSelect}>
            Switch to {plan.name}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function PlanLimit({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="font-mono text-foreground text-right break-all min-w-0">{value}</dd>
    </div>
  );
}