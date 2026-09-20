import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Layout } from "../components/Layout.jsx";
import { cn } from "../lib/utils.js";
import { Mail, Globe, HardDrive, Zap, Router, AlertCircle } from "lucide-react";

const serviceConfig = {
  smtp:   { label: "Email",         icon: Mail,      unit: "emails",      limitKey: "smtp_monthly" },
  backup: { label: "Cloud backup",  icon: HardDrive, unit: "GB",          limitKey: "backup_gb" },
  ai:     { label: "AI assistant",  icon: Zap,       unit: "credits",     limitKey: "ai_credit_cents" },
  domain: { label: "Domain & DNS",  icon: Globe,     unit: "queries",     limitKey: null },
  tunnel: { label: "Tunnel",        icon: Router,    unit: "GB",          limitKey: "tunnel_gb_per_mo" },
};

function pct(used, limit) {
  if (!limit || limit <= 0) return null;
  return Math.min(100, (used / limit) * 100);
}

export default function Usage() {
  const { account } = useAuth();
  const { data: usage, isLoading, error } = useQuery({ queryKey: ["usage"], queryFn: api.getUsage });
  const { data: plansData } = useQuery({ queryKey: ["plans"], queryFn: api.getPlans });
  const { data: devicesData } = useQuery({
    queryKey: ["devices"],
    queryFn: api.getDevices,
  });

  const plans = plansData?.plans || [];
  const plan = plans.find((p) => p.id === (usage?.plan_id || account?.plan_id || "free"));
  const devices = (devicesData?.devices || []).filter((d) => d.is_active);
  // The device serving this account, for showing its real address on the
  // Domain & DNS row instead of the plan's wildcard.
  const currentDomain = devices[0]?.current_domain || "";

  const byService = usage?.by_service || {};
  const entries = Object.entries(byService);

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <h1 className="font-mono text-xl mb-1.5">Usage</h1>
        <p className="text-sm text-muted-foreground mb-8">
          This billing cycle
          {usage?.current_cycle_start && (
            <> · {new Date(usage.current_cycle_start).toLocaleDateString()} →{" "}
              {new Date(usage.current_cycle_end).toLocaleDateString()}</>
          )}
        </p>

        {isLoading ? (
          <UsageSkeleton />
        ) : error ? (
          <Card><CardContent className="py-8">
            <p className="flex items-center gap-1.5 text-sm text-error">
              <AlertCircle className="w-4 h-4" /> Couldn't load usage. {error.message}
            </p>
          </CardContent></Card>
        ) : !usage?.device_id ? (
          <Card><CardContent className="py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No device linked yet — usage appears here once your device uses Connect services.
            </p>
          </CardContent></Card>
        ) : (
          <div className="space-y-8">
            {/* Summary strip */}
            <dl className="grid grid-cols-3 gap-4">
              <Stat label="Total cost" value={`$${(usage.total_cost_usd || 0).toFixed(4)}`} />
              <Stat label="Credits used" value={`$${((usage.credits_used || 0) / 100).toFixed(2)}`} />
              <Stat label="Credit balance" value={`$${((usage.credit_balance_cents || 0) / 100).toFixed(2)}`} />
            </dl>

            {/* Per-service */}
            <section>
              <SectionHeader label="By service" />
              {entries.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center border border-dashed border-border rounded-large-element">
                  No usage recorded yet this cycle.
                </p>
              ) : (
                <ul className="space-y-3">
                  {entries.map(([key, svc]) => (
                    <ServiceRow key={key} svcKey={key} svc={svc} plan={plan} currentDomain={currentDomain} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </Layout>
  );
}

function SectionHeader({ label }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground shrink-0">{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <Card>
      <CardContent className="py-4">
        <dt className="text-xs text-muted-foreground mb-1">{label}</dt>
        <dd className="font-mono text-xl leading-none">{value}</dd>
      </CardContent>
    </Card>
  );
}

function ServiceRow({ svcKey, svc, plan, currentDomain }) {
  const cfg = serviceConfig[svcKey];
  if (!cfg) return null;
  const Icon = cfg.icon;
  const limit = cfg.limitKey ? plan?.limits?.[cfg.limitKey] : null;
  const used = svc.value || 0;
  const percentage = pct(used, limit);
  const over = limit && used > limit ? used - limit : 0;

  const value =
    limit
      ? `${used.toLocaleString()} / ${limit.toLocaleString()} ${cfg.unit}`
      : svcKey === "domain"
        ? (currentDomain || "Included")
        : used > 0
          ? `${used.toLocaleString()} ${cfg.unit}`
          : "Included";

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center gap-3">
          <Icon className="w-5 h-5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-mono text-sm">{cfg.label}</p>
              <p className="font-mono text-xs text-foreground shrink-0">
                {value}
              </p>
            </div>
            {percentage !== null && (
              <>
                <div className="h-1.5 rounded-pill bg-muted overflow-hidden mt-2">
                  <div
                    className={cn(
                      "h-full rounded-pill transition-all duration-500 ease-out",
                      over > 0 ? "bg-error" : percentage > 80 ? "bg-warning" : "bg-success"
                    )}
                    style={{ width: `${Math.min(percentage, 100)}%` }}
                  />
                </div>
                <p className={cn("text-xs mt-1.5", over > 0 ? "text-error" : "text-muted-foreground")}>
                  {over > 0 ? `${over.toLocaleString()} ${cfg.unit} over limit` : `${percentage.toFixed(0)}% used`}
                </p>
              </>
            )}
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs text-muted-foreground">Cost</p>
            <p className="font-mono text-sm">${(svc.cost_usd || 0).toFixed(4)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function UsageSkeleton() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="grid grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => <div key={i} className="h-20 rounded-large-element bg-accent" />)}
      </div>
      <div className="h-3 w-24 rounded bg-accent" />
      <div className="space-y-3">
        {[0, 1, 2].map((i) => <div key={i} className="h-16 w-full rounded-large-element bg-accent" />)}
      </div>
    </div>
  );
}