import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { StatusBadge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";
import { AlertCircle, ExternalLink, Loader2 } from "lucide-react";

/**
 * Billing — credit balance, payment method, invoices, transactions, and
 * subscription management.
 */
export default function Billing() {
  const queryClient = useQueryClient();
  const { data: billing, isLoading, error } = useQuery({ queryKey: ["billing"], queryFn: api.getBilling });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelError, setCancelError] = useState("");

  const cancelMut = useMutation({
    mutationFn: api.cancel,
    onSuccess: () => {
      setConfirmCancel(false);
      setCancelError("");
      queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (err) => setCancelError(err.message || "Could not schedule your cancellation."),
  });

  const resumeMut = useMutation({
    mutationFn: api.resumeSubscription,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["billing"] }),
    onError: (err) => setCancelError(err.message || "Could not resume your subscription."),
  });

  const portalMut = useMutation({
    mutationFn: api.getBillingPortal,
    onSuccess: (data) => {
      if (data.portal_url && data.portal_url !== "/billing") {
        window.open(data.portal_url, "_blank", "noopener,noreferrer");
      }
    },
  });

  const balance = billing?.credit_balance_cents || 0;
  const invoices = billing?.invoices || [];
  const transactions = billing?.transactions || [];

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <h1 className="font-mono text-xl mb-8">Billing</h1>

        {isLoading ? (
          <BillingSkeleton />
        ) : error ? (
          <Card><CardContent className="py-8">
            <p className="flex items-center gap-1.5 text-sm text-error">
              <AlertCircle className="w-4 h-4" /> Couldn't load billing. {error.message}
            </p>
          </CardContent></Card>
        ) : (
          <div className="space-y-8">
            {/* Balance + payment */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader><CardTitle className="text-sm text-muted-foreground">Credit balance</CardTitle></CardHeader>
                <CardContent>
                  <p className="font-mono text-3xl">${(balance / 100).toFixed(2)}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Applies to subscriptions and overage charges.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-sm text-muted-foreground">Payment method</CardTitle></CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground mb-3">
                    Managed securely by Stripe, our payment processor.
                  </p>
                  <Button variant="outline" loading={portalMut.isPending} onClick={() => portalMut.mutate()}>
                    <ExternalLink className="w-4 h-4" /> Manage in Stripe
                  </Button>
                </CardContent>
              </Card>
            </div>

            {/* Invoices */}
            <section>
              <SectionHeader label="Invoices" />
              {invoices.length === 0 ? (
                <EmptyNote text="No invoices yet. They'll appear here after your first billing cycle." />
              ) : (
                <ul className="divide-y divide-border rounded-large-element border border-border overflow-hidden">
                  {invoices.map((inv) => (
                    <li key={inv.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="font-mono text-sm">
                          {new Date(inv.period_start).toLocaleDateString()} — {new Date(inv.period_end).toLocaleDateString()}
                        </p>
                        <p className="text-sm text-muted-foreground">${(inv.amount_cents / 100).toFixed(2)}</p>
                      </div>
                      <StatusBadge status={inv.status} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Transactions */}
            <section>
              <SectionHeader label="Recent transactions" />
              {transactions.length === 0 ? (
                <EmptyNote text="No transactions yet. Credit purchases and usage charges appear here." />
              ) : (
                <ul className="divide-y divide-border rounded-large-element border border-border overflow-hidden">
                  {transactions.map((tx, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="font-mono text-sm truncate">{tx.reason}</p>
                        <p className="text-xs text-muted-foreground">{new Date(tx.created_at).toLocaleString()}</p>
                      </div>
                      <p className={`font-mono shrink-0 ${tx.direction === "credit" ? "text-success" : "text-foreground"}`}>
                        {tx.direction === "credit" ? "+" : "−"}${(tx.amount_cents / 100).toFixed(2)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Cancel */}
            <section>
              <SectionHeader label="Subscription" />
              <SubscriptionCard
                subscription={billing?.subscription}
                confirmCancel={confirmCancel}
                setConfirmCancel={setConfirmCancel}
                cancelMut={cancelMut}
                resumeMut={resumeMut}
                cancelError={cancelError}
              />
            </section>
          </div>
        )}
      </div>
    </Layout>
  );
}

function SubscriptionCard({ subscription, confirmCancel, setConfirmCancel, cancelMut, resumeMut, cancelError }) {
  const pending = !!subscription?.cancel_at_period_end;
  const periodEnd = subscription?.period_end ? new Date(subscription.period_end).toLocaleDateString() : null;
  const isPaid = subscription && subscription.plan_id && subscription.plan_id !== "free";

  if (pending) {
    return (
      <Card className="border-warning/30">
        <CardContent className="py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">
                {subscription.plan_name} ends {periodEnd ? `on ${periodEnd}` : "at the end of the billing cycle"}.
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                You keep your paid features until then, when your device moves to Free.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => resumeMut.mutate()} loading={resumeMut.isPending}>
              Keep subscription
            </Button>
          </div>
          {cancelError && (
            <p className="flex items-center gap-1.5 text-xs text-error mt-3">
              <AlertCircle className="w-3.5 h-3.5" /> {cancelError}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  if (!isPaid) return null;

  return (
    <Card className="border-destructive/30">
      <CardContent className="py-4">
        {!confirmCancel ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              Cancelling downgrades your device to Free at the end of the billing cycle.
              You keep your paid features until then.
            </p>
            <Button variant="destructive" size="sm" onClick={() => setConfirmCancel(true)}>
              Cancel subscription
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Schedule cancellation for the end of this billing cycle? Your device
              stays on {subscription.plan_name} until then, then moves to Free.
              You can change your mind anytime before the cycle ends.
            </p>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                loading={cancelMut.isPending}
                onClick={() => cancelMut.mutate()}
              >
                Yes, cancel at cycle end
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)}>
                Keep my plan
              </Button>
            </div>
            {cancelError && (
              <p className="flex items-center gap-1.5 text-xs text-error">
                <AlertCircle className="w-3.5 h-3.5" /> {cancelError}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
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

function EmptyNote({ text }) {
  return <p className="text-sm text-muted-foreground py-6 text-center border border-dashed border-border rounded-large-element">{text}</p>;
}

function BillingSkeleton() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-32 rounded-large-element bg-accent" />
        <div className="h-32 rounded-large-element bg-accent" />
      </div>
      <div className="h-3 w-24 rounded bg-accent" />
      <div className="h-40 w-full rounded-large-element bg-accent" />
    </div>
  );
}