import { useEffect, useState } from "react";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { VerifyHumanCard } from "../components/VerifyHumanCard.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { api, downloadBackup } from "../api.js";
import { stripeLooksConfigured } from "../billing/stripeConfig.js";

export function BackupsTab({ me, objects, note, onRefresh, setError, error }) {
  const [busy, setBusy] = useState(false);

  async function attach(paymentMethodId) {
    const body = paymentMethodId
      ? JSON.stringify({ payment_method_id: paymentMethodId })
      : "{}";
    await api("/api/v1/billing/attach-card", { method: "POST", body });
    await onRefresh();
  }

  if (!me.has_card) {
    return (
      <Card className="animate-fade-in-up" data-testid="backups-gated">
        <CardHeader>
          <CardTitle>Add a payment card</CardTitle>
          <CardDescription>
            Add a payment card so we can store a cloud backup of your files off-site. It costs $7 per terabyte each month.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {stripeLooksConfigured(me) ? (
            <VerifyHumanCard
              account={me}
              loading={busy}
              description="Add a payment card so we can store a cloud backup. It costs $7 per terabyte each month."
              buttonLabel="Add a payment card"
              onConfirm={async (paymentMethodId) => {
                setError("");
                setBusy(true);
                try {
                  await attach(paymentMethodId);
                } catch (err) {
                  setError(err.message);
                } finally {
                  setBusy(false);
                }
              }}
            />
          ) : (
            <Button
              type="button"
              onClick={async () => {
                try {
                  await attach("");
                } catch (err) {
                  setError(err.message);
                }
              }}
            >
              Add a payment card
            </Button>
          )}
          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="animate-fade-in-up" data-testid="backups-open">
      <CardHeader>
        <CardTitle>Cloud backup</CardTitle>
        <CardDescription>
          Cloud backup costs $7 per terabyte each month, based on how much is stored right now.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="font-mono">About ${Number(me.estimated_month || 0).toFixed(2)} this month</p>
        <p className="text-sm text-muted-foreground">{note || "This is the latest copy we have, not a history of old versions."}</p>
        {objects.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing stored yet. On Luna, choose folders or a whole drive after pairing.</p>
        ) : (
          <ul className="space-y-2">
            {objects.map((o) => (
              <li key={`${o.device_id}-${o.relative_path}`} className="flex justify-between gap-3 rounded-large-element border border-border px-4 py-3">
                <span className="font-mono break-all text-sm">{o.relative_path}</span>
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await downloadBackup(o.device_id, o.relative_path);
                    } catch (err) {
                      setError(err.message);
                    }
                  }}
                >
                  Download
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function BackupsPage() {
  const { me, refresh } = useAuth();
  const [objects, setObjects] = useState([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!me?.has_card) return;
    api("/api/v1/backups")
      .then((b) => {
        setObjects(b.objects || []);
        setNote(b.note || "");
      })
      .catch((err) => setError(err.message));
  }, [me?.has_card]);

  return (
    <Layout>
      <h1 className="font-mono text-3xl mb-2">Cloud backups</h1>
      <p className="text-muted-foreground mb-8">A second place for your files if a drive fails or the house is gone. Latest copy only.</p>
      <BackupsTab me={me} objects={objects} note={note} onRefresh={refresh} setError={setError} error={error} />
    </Layout>
  );
}
