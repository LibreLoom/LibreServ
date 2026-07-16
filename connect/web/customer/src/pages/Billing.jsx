import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { StatusBadge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";

export default function Billing() {
  const queryClient = useQueryClient();
  const { data: billing } = useQuery({ queryKey: ["billing"], queryFn: api.getBilling });

  const cancelMut = useMutation({
    mutationFn: api.cancel,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["billing"] }),
  });

  const balance = billing?.credit_balance_cents || 0;
  const invoices = billing?.invoices || [];
  const transactions = billing?.transactions || [];

  return (
    <Layout>
      <h2 className="font-mono text-2xl font-bold mb-6">Billing</h2>

      <Card className="mb-6">
        <CardHeader><CardTitle className="text-sm text-muted-foreground">Account Credit Balance</CardTitle></CardHeader>
        <CardContent>
          <p className="font-mono text-3xl font-bold">${(balance / 100).toFixed(2)}</p>
          <p className="text-sm text-muted-foreground mt-1">1 credit = $0.01. Credits apply to subscriptions and overage.</p>
        </CardContent>
      </Card>

      <h3 className="font-mono text-lg font-bold mb-4">Invoices</h3>
      {invoices.length === 0 ? (
        <Card className="mb-8"><p className="text-muted-foreground text-center">No invoices yet.</p></Card>
      ) : (
        <div className="space-y-2 mb-8">
          {invoices.map((inv) => (
            <Card key={inv.id} className="flex items-center justify-between">
              <div>
                <p className="font-mono text-sm">
                  {new Date(inv.period_start).toLocaleDateString()} — {new Date(inv.period_end).toLocaleDateString()}
                </p>
                <p className="text-sm text-muted-foreground">${(inv.amount_cents / 100).toFixed(2)}</p>
              </div>
              <StatusBadge status={inv.status} />
            </Card>
          ))}
        </div>
      )}

      <h3 className="font-mono text-lg font-bold mb-4">Recent Transactions</h3>
      {transactions.length === 0 ? (
        <Card className="mb-8"><p className="text-muted-foreground text-center">No transactions yet.</p></Card>
      ) : (
        <div className="space-y-2 mb-8">
          {transactions.map((tx, i) => (
            <Card key={i} className="flex items-center justify-between">
              <div>
                <p className="font-mono text-sm">{tx.reason}</p>
                <p className="text-sm text-muted-foreground">{new Date(tx.created_at).toLocaleString()}</p>
              </div>
              <p className={`font-mono font-bold ${tx.direction === "credit" ? "text-success" : "text-destructive"}`}>
                {tx.direction === "credit" ? "+" : "−"}${(tx.amount_cents / 100).toFixed(2)}
              </p>
            </Card>
          ))}
        </div>
      )}

      <Card className="border-destructive/30">
        <CardHeader><CardTitle className="text-sm text-destructive">Cancel Subscription</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Cancelling will downgrade your device to the Free plan at the end of the current billing cycle.
            You can re-subscribe at any time.
          </p>
          <Button
            variant="destructive"
            loading={cancelMut.isPending}
            onClick={() => { if (confirm("Are you sure you want to cancel your subscription?")) cancelMut.mutate(); }}
          >
            Cancel Subscription
          </Button>
        </CardContent>
      </Card>
    </Layout>
  );
}
