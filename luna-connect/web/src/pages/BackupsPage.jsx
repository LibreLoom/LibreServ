import { useEffect, useState } from "react";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { InfoHint } from "../components/ui/Tooltip.jsx";
import { VerifyHumanCard } from "../components/VerifyHumanCard.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api.js";
import { stripeLooksConfigured } from "../billing/stripeConfig.js";
import { BackupBrowser } from "../components/BackupBrowser.jsx";

function daysUntil(unixSeconds) {
  if (!unixSeconds) return null;
  return Math.max(0, Math.ceil((unixSeconds * 1000 - Date.now()) / 86400000));
}

function PricingChunks({ compact = false }) {
  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      <div className="rounded-large-element border border-border px-4 py-3">
        <p className="font-mono text-sm">Storage</p>
        <p className="text-sm text-muted-foreground mt-1">
          $8 per terabyte each month, based on your average storage over the month.
        </p>
      </div>
      <div className="rounded-large-element border border-border px-4 py-3">
        <p className="font-mono text-sm">Downloads</p>
        <p className="text-sm text-muted-foreground mt-1">
          Free up to three times your average storage. Extra download traffic is $0.01 per GB.
        </p>
      </div>
    </div>
  );
}

function MonthlyEstimate({ amount }) {
  return (
    <div className="rounded-large-element border border-border bg-background px-5 py-4">
      <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-1">
        Estimated this month
      </p>
      <p className="font-mono text-3xl">${Number(amount || 0).toFixed(2)}</p>
    </div>
  );
}

function BackupFilesCard({ objects, note, unpairedNote, setError }) {
  const fileList = objects.length === 0 ? (
    <p className="text-sm text-muted-foreground">
      Nothing stored yet. On Luna, choose folders or a whole drive after pairing.
    </p>
  ) : (
    <BackupBrowser objects={objects} onError={(message) => setError(message)} />
  );

  return (
    <Card className="animate-fade-in-up" data-testid="backups-files">
      <CardHeader>
        <CardTitle>
          Your cloud copies
          <InfoHint
            content="These are the files we keep off-site. You can browse and download them here. We store the latest copy only, not older versions."
            label="About your cloud copies"
          />
        </CardTitle>
        <CardDescription>Browse and download files from your cloud backup.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {note && (
          <p className="text-sm text-muted-foreground">{note}</p>
        )}
        {unpairedNote}
        {fileList}
      </CardContent>
    </Card>
  );
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

  const unpairedNote = !paired && objects.length > 0 ? (
    <p className="text-sm leading-relaxed">
      These are copies from a Luna that is no longer paired. The monthly bill stays until you turn payment off.
    </p>
  ) : null;

  const filesCard = (
    <BackupFilesCard
      objects={objects}
      note={purging || !me.has_card ? "" : note}
      unpairedNote={unpairedNote}
      setError={setError}
    />
  );

  let billingCard;

  if (purging) {
    billingCard = (
      <Card className="animate-fade-in-up" data-testid="backups-purging">
        <CardHeader>
          <CardTitle>Payment is off</CardTitle>
          <CardDescription>
            We still have your cloud copies for {daysLeft === 1 ? "1 more day" : `${daysLeft} more days`}. Download anything you need before they are gone.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <PricingChunks compact />
          {addCard}
          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    );
  } else if (!me.has_card) {
    billingCard = (
      <Card className="animate-fade-in-up" data-testid="backups-gated">
        <CardHeader>
          <CardTitle>Add a payment card</CardTitle>
          <CardDescription>
            Add a payment card so we can store a cloud backup of your files off-site.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <PricingChunks />
          {addCard}
          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    );
  } else {
    billingCard = (
      <Card className="animate-fade-in-up" data-testid="backups-open">
        <CardHeader>
          <CardTitle>Cloud backup</CardTitle>
          <CardDescription>
            Off-site copies of your files if a drive fails or your Luna is gone.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <MonthlyEstimate amount={me.estimated_month} />
          <PricingChunks />
          <p className="text-sm text-muted-foreground">
            {note || "This is the latest copy we have, not a history of old versions."}
          </p>
          {!confirmCancel ? (
            <Button variant="destructive" onClick={() => setConfirmCancel(true)}>
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

  return (
    <div className="space-y-6">
      {billingCard}
      {filesCard}
    </div>
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
