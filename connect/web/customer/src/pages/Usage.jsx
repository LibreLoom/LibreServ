import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Layout } from "../components/Layout.jsx";
import { cn } from "../lib/utils.js";
import {
  Mail, Globe, HardDrive, Zap, Headphones, Router,
} from "lucide-react";

const serviceConfig = {
  smtp:     { label: "Email",          icon: Mail,       unit: "emails",   limitKey: "smtp_monthly",      limitLabel: (v) => `${v} emails/mo` },
  backup:   { label: "Cloud Backup",   icon: HardDrive,  unit: "GB",        limitKey: "backup_gb",         limitLabel: (v) => `${v} GB included` },
  ai:       { label: "AI Assistant",   icon: Zap,        unit: "credits",   limitKey: "ai_credit_cents",   limitLabel: (v) => `$${(v / 100).toFixed(2)} credits` },
  domain:   { label: "Domain & DNS",   icon: Globe,      unit: "queries",   limitKey: null,                limitLabel: () => "Included" },
  tunnel:   { label: "Tunnel Access",  icon: Router,     unit: "connections", limitKey: null,              limitLabel: () => "Included" },
  support:  { label: "Human Support",  icon: Headphones, unit: "requests",  limitKey: null,                limitLabel: () => "Included" },
};

function pct(used, limit) {
  if (!limit || limit <= 0) return null;
  return Math.min(100, (used / limit) * 100);
}

function overageAmount(used, limit) {
  if (!limit || limit <= 0) return 0;
  return Math.max(0, used - limit);
}

function ProgressRing({ percentage, overage }) {
  const color = overage > 0 ? "var(--color-error)" : percentage > 80 ? "var(--color-warning)" : "var(--color-success)";
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (Math.min(percentage, 100) / 100) * circumference;
  return (
    <svg className="w-12 h-12 -rotate-90 shrink-0" viewBox="0 0 48 48">
      <circle cx="24" cy="24" r={radius} fill="none" stroke="var(--color-muted)" strokeWidth="3" />
      <circle
        cx="24" cy="24" r={radius} fill="none" stroke={color} strokeWidth="3"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        className="transition-all duration-500 ease-out"
      />
    </svg>
  );
}

function ServiceRow({ svcKey, svc, plan }) {
  const cfg = serviceConfig[svcKey];
  if (!cfg) return null;
  const Icon = cfg.icon;
  const limit = cfg.limitKey ? plan?.limits?.[cfg.limitKey] : null;
  const used = svc.value || 0;
  const percentage = limit ? pct(used, limit) : null;
  const overage = limit ? overageAmount(used, limit) : 0;
  const unlimited = limit === null;

  return (
    <Card className="p-4">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 rounded-large-element bg-muted items-center justify-center shrink-0">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <div>
              <p className="font-mono text-sm">{cfg.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {unlimited ? "Included in plan" : cfg.limitLabel(limit)}
              </p>
            </div>
            {percentage !== null && (
              <ProgressRing percentage={percentage} overage={overage} />
            )}
          </div>

          {/* Progress bar */}
          {!unlimited && percentage !== null && (
            <div className="mt-3">
              <div className="h-2 rounded-pill bg-muted overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-pill transition-all duration-500 ease-out",
                    overage > 0 ? "bg-error" : percentage > 80 ? "bg-warning" : "bg-success"
                  )}
                  style={{ width: `${Math.min(percentage, 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between mt-2">
                <p className="text-xs font-mono">
                  <span className="text-foreground">{used.toLocaleString()}</span>
                  <span className="text-muted-foreground"> / {limit?.toLocaleString()} {cfg.unit}</span>
                </p>
                <p className={cn(
                  "text-xs font-mono",
                  overage > 0 ? "text-error" : percentage > 80 ? "text-warning" : "text-muted-foreground"
                )}>
                  {percentage.toFixed(0)}%
                  {overage > 0 && ` · ${overage.toLocaleString()} over`}
                </p>
              </div>
            </div>
          )}

          {/* Unlimited/included services — just show usage */}
          {unlimited && (
            <div className="mt-3">
              <p className="text-xs font-mono text-muted-foreground">
                {used > 0 ? `${used.toFixed(2)} ${cfg.unit} used` : "No usage this cycle"}
              </p>
            </div>
          )}

          {/* Cost line */}
          <div className="flex items-center gap-4 mt-3 pt-3 border-t border-border">
            <div>
              <p className="text-xs text-muted-foreground">Cost</p>
              <p className="font-mono text-sm">${(svc.cost_usd || 0).toFixed(4)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Credits</p>
              <p className="font-mono text-sm">{((svc.credits_used || 0) / 100).toFixed(2)}</p>
            </div>
            {overage > 0 && (
              <div>
                <p className="text-xs text-muted-foreground">Overage</p>
                <p className="font-mono text-sm text-error">{overage.toLocaleString()} {cfg.unit}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

export default function Usage() {
  const { account } = useAuth();
  const { data: usage } = useQuery({ queryKey: ["usage"], queryFn: api.getUsage });
  const { data: plansData } = useQuery({ queryKey: ["plans"], queryFn: api.getPlans });

  const byService = usage?.by_service || {};
  const entries = Object.entries(byService);
  const plans = plansData?.plans || [];
  const accountPlanId = account?.plan_id || "free";
  const plan = plans.find((p) => p.id === accountPlanId);

  const totalCost = usage?.total_cost_usd || 0;
  const creditsUsed = usage?.credits_used || 0;
  const creditBalance = usage?.credit_balance_cents || 0;
  const cycleStart = usage?.current_cycle_start;
  const cycleEnd = usage?.current_cycle_end;

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-6">Usage</h2>

      {/* Billing cycle */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">Current Billing Cycle</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Start</p>
              <p className="font-mono">{cycleStart ? new Date(cycleStart).toLocaleDateString() : "—"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">End</p>
              <p className="font-mono">{cycleEnd ? new Date(cycleEnd).toLocaleDateString() : "—"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary cards */}
      <div className="grid gap-4 md:grid-cols-3 mb-6">
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Total Cost</CardTitle></CardHeader>
          <CardContent>
            <p className="font-mono text-2xl">${totalCost.toFixed(4)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {totalCost === 0 ? "No charges this cycle" : "At-cost usage charges"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Credits Used</CardTitle></CardHeader>
          <CardContent>
            <p className="font-mono text-2xl">${(creditsUsed / 100).toFixed(2)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Included credits consumed
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Credit Balance</CardTitle></CardHeader>
          <CardContent>
            <p className="font-mono text-2xl">${(creditBalance / 100).toFixed(2)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {creditBalance > 0 ? "Remaining for this cycle" : "No credits remaining"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Per-service breakdown */}
      <h3 className="font-mono text-lg mb-4">By Service</h3>
      {entries.length === 0 ? (
        <Card>
          <p className="text-muted-foreground text-center py-8">
            No usage recorded yet this cycle. Usage appears here once your device starts using Connect services.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {entries.map(([key, svc]) => (
            <ServiceRow key={key} svcKey={key} svc={svc} plan={plan} />
          ))}
        </div>
      )}
    </Layout>
  );
}
