import { useEffect, useState } from "react";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { VerifyHumanCard } from "../components/VerifyHumanCard.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api.js";
import { stripeLooksConfigured } from "../billing/stripeConfig.js";
import { BackupBrowser } from "../components/BackupBrowser.jsx";

function daysUntil(unixSeconds) {
  if (!unixSeconds) return null;
  return Math.max(0, Math.ceil((unixSeconds * 1000 - Date.now()) / 86400000));
}

export function BackupsTab({ me, objects, note, paired, onRefresh, setError, error }) {
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const purgeAfter = Number(me?.backup_purge_after || 0);
  const daysLeft = daysUntil(purgeAfter);
  const purging = purgeAfter > 0;

  async function attach(paymentMethodId) {
    const body = paymentMethodId
      ? JSON.stringify({ payment_method_id: paymentMethodId })
      : "{}";
    await api("/api/v1/billing/attach-card", { method: "POST", body });
    await onRefresh();
  }

  async function cancelPayment() {
    setError("");
    setBusy(true);
    try {
      await api("/api/v1/billing/cancel", { method: "POST", body: "{}" });
      setConfirmCancel(false);
      await onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const addCard = (
    stripeLooksConfigured(me) ? (
      <VerifyHumanCard
        account={me}
        loading={busy}
        description="Add a payment card so we can store a cloud backup. It costs $8 per terabyte each month."
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
    )
  );

  const fileList = objects.length === 0 ? (
    <p className="text-sm text-muted-foreground">Nothing stored yet. On Luna, choose folders or a whole drive after pairing.</p>
  ) : (
    <BackupBrowser objects={objects} onError={(message) => setError(message)} />
  );

  const unpairedNote = !paired && objects.length > 0 ? (
    <p className="text-sm leading-relaxed">
      These are copies from a Luna that is no longer paired. The monthly bill stays until you turn payment off.
    </p>
  ) : null;

  if (purging) {
    return (
      <Card className="animate-fade-in-up" data-testid="backups-purging">
        <CardHeader>
          <CardTitle>Payment is off</CardTitle>
          <CardDescription>
            We still have your cloud copies for {daysLeft === 1 ? "1 more day" : `${daysLeft} more days`}. Download anything you need before they are gone.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {unpairedNote}
          {fileList}
          {addCard}
          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    );
  }

  if (!me.has_card) {
    return (
      <Card className="animate-fade-in-up" data-testid="backups-gated">
        <CardHeader>
          <CardTitle>Add a payment card</CardTitle>
          <CardDescription>
            Add a payment card so we can store a cloud backup of your files off-site. It costs $8 per terabyte each month.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {unpairedNote}
          {objects.length > 0 && fileList}
          {addCard}
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
          Cloud backup costs $8 per terabyte each month, based on your average storage over the month. Downloads are free up to three times that average; extra download traffic is $0.01 per GB.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="font-mono">About ${Number(me.estimated_month || 0).toFixed(2)} this month</p>
        <p className="text-sm text-muted-foreground">{note || "This is the latest copy we have, not a history of old versions."}</p>
        {unpairedNote}
        {fileList}
        {!confirmCancel ? (
          <Button variant="outline" onClick={() => setConfirmCancel(true)}>
            Turn off payment
          </Button>
        ) : (
          <div className="rounded-large-element bg-background text-foreground border border-border px-4 py-4 space-y-3">
            <p className="text-sm leading-relaxed">
              Payment stops today. We keep your cloud copies for 30 days. Download anything you need before then. After 30 days we delete them.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button variant="destructive" loading={busy} onClick={cancelPayment}>
                Turn off payment
              </Button>
              <Button variant="outline" onClick={() => setConfirmCancel(false)}>
                Keep payment on
              </Button>
            </div>
          </div>
        )}
        {error && <p className="text-sm text-error">{error}</p>}
      </CardContent>
    </Card>
  );
}

export default function BackupsPage() {
  const { me, refresh } = useAuth();
  const [objects, setObjects] = useState([]);
  const [note, setNote] = useState("");
  const [paired, setPaired] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!me) return;
    api("/api/v1/backups")
      .then((b) => {
        setObjects(b.objects || []);
        setNote(b.note || "");
      })
      .catch((err) => setError(err.message));
    api("/api/v1/account/devices")
      .then((d) => setPaired((d.devices || []).length > 0))
      .catch(() => {});
  }, [me?.id, me?.has_card, me?.backup_purge_after]);

  return (
    <Layout>
      <h1 className="font-mono text-3xl mb-2">Cloud backups</h1>
      <p className="text-muted-foreground mb-8">A second place for your files if a drive fails or the house is gone. Latest copy only.</p>
      <BackupsTab me={me} objects={objects} note={note} paired={paired} onRefresh={refresh} setError={setError} error={error} />
    </Layout>
  );
}
