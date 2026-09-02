import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Separator } from "../components/ui/separator.jsx";
import { InfoHint, TermHint } from "../components/ui/Tooltip.jsx";
import { VerifyHumanCard } from "../components/VerifyHumanCard.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api.js";
import { stripeLooksConfigured } from "../billing/stripeConfig.js";
import { BackupBrowser } from "../components/BackupBrowser.jsx";

function daysUntil(unixSeconds) {
  if (!unixSeconds) return null;
  return Math.max(0, Math.ceil((unixSeconds * 1000 - Date.now()) / 86400000));
}

/** Chunked pricing — Miller's Law / Law of Common Region. */
function PricingSummary({ surface = "secondary" }) {
  return (
    <section className="space-y-3" aria-labelledby="backup-pricing-heading">
      <div className="flex items-center gap-2">
        <h4 id="backup-pricing-heading" className="font-mono text-xs uppercase tracking-widest text-foreground">
          Pricing
        </h4>
        <InfoHint
          surface={surface}
          delayMs={0}
          label="How cloud backup pricing works"
          content="We bill from your average storage over the month, not a single day. Downloads are free up to three times that average; extra download traffic costs $0.01 per GB."
        />
      </div>
      <div
        className="overflow-x-auto rounded-large-element border border-border bg-background text-foreground"
        data-testid="backup-pricing-table"
      >
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b border-border">
              <th scope="row" className="px-3 py-2.5 text-left font-normal align-top">
                Storage
              </th>
              <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap align-top">
                $8 / terabyte / month
              </td>
            </tr>
            <tr className="border-b border-border">
              <th scope="row" className="px-3 py-2.5 text-left font-normal align-top">
                Downloads
              </th>
              <td className="px-3 py-2.5 text-right leading-snug align-top">
                <span className="block">Free each month</span>
                <span className="block">
                  Up to 3×{" "}
                  <TermHint
                    surface={surface}
                    delayMs={0}
                    content="How much you store in the cloud on average during the month — not one day's total. You can download up to three times that amount without extra charge."
                  >
                    average storage
                  </TermHint>
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row" className="px-3 py-2.5 text-left font-normal align-top">
                Extra download traffic
              </th>
              <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap align-top">
                $0.01 / GB
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Von Restorff — current cost stands out from pricing details. */
function MonthlyCostHighlight({ amount }) {
  const formatted = Number(amount || 0).toFixed(2);
  return (
    <section
      className="rounded-large-element border-2 border-accent bg-accent/10 text-foreground px-5 py-4"
      aria-labelledby="backup-cost-heading"
      data-testid="backup-monthly-cost"
    >
      <p id="backup-cost-heading" className="font-mono text-xs uppercase tracking-widest">
        This month
      </p>
      <p className="font-mono text-3xl mt-1">${formatted}</p>
      <p className="text-sm mt-2">Estimated from your average storage so far.</p>
    </section>
  );
}

function EmptyStorageState({ paired }) {
  return (
    <div
      className="rounded-large-element border border-dashed border-border px-6 py-8 text-center space-y-2"
      data-testid="backup-empty-state"
    >
      <HardDrive className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
      <p className="font-mono text-sm">Nothing stored yet</p>
      <p className="text-sm leading-relaxed max-w-md mx-auto">
        {paired
          ? "On Luna, choose folders or a whole drive to back up."
          : "Pair a Luna, then choose folders or a whole drive to back up."}
      </p>
    </div>
  );
}

function VersionNote({ note }) {
  const text = note || "This is the latest copy we have, not a history of old versions.";
  return (
    <p className="text-sm text-muted-foreground leading-relaxed flex flex-wrap items-center gap-1">
      <span>{text}</span>
      <InfoHint
        surface="secondary"
        delayMs={0}
        label="About cloud backup copies"
        content="Cloud backup keeps one current copy of each file you choose. It is not a timeline of older versions you can roll back to."
      />
    </p>
  );
}

function CancelPaymentSection({ confirmCancel, setConfirmCancel, busy, onCancel }) {
  if (!confirmCancel) {
    return (
      <section className="space-y-2" aria-labelledby="backup-actions-heading">
        <h4 id="backup-actions-heading" className="font-mono text-xs uppercase tracking-widest">
          Payment
        </h4>
        <Button variant="destructive" size="lg" onClick={() => setConfirmCancel(true)}>
          Turn off payment
        </Button>
      </section>
    );
  }

  return (
    <section
      className="rounded-large-element border border-error/30 bg-error/10 text-foreground px-4 py-4 space-y-3"
      data-testid="backup-cancel-confirm"
      aria-labelledby="backup-cancel-heading"
    >
      <h4 id="backup-cancel-heading" className="font-mono text-sm">
        Turn off payment?
      </h4>
      <p className="text-sm leading-relaxed">
        Payment stops today. We keep your cloud copies for 30 days. Download anything you need before then. After 30 days we delete them.
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <Button variant="destructive" size="lg" loading={busy} onClick={onCancel}>
          Turn off payment
        </Button>
        <Button variant="outline" size="lg" onClick={() => setConfirmCancel(false)}>
          Keep payment on
        </Button>
      </div>
    </section>
  );
}

function BackupFilesCard({ objects, note, unpairedNote, paired, setError }) {
  const storageSection = objects.length === 0 ? (
    <EmptyStorageState paired={paired} />
  ) : (
    <BackupBrowser objects={objects} onError={(message) => setError(message)} />
  );

  return (
    <Card className="animate-fade-in-up" data-testid="backups-files">
      <CardHeader>
        <CardTitle>
          Your files
          <InfoHint
            surface="secondary"
            delayMs={0}
            label="About your cloud copies"
            content="These are the files we keep off-site. You can browse and download them here."
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {note ? <VersionNote note={note} /> : null}
        {unpairedNote}
        {storageSection}
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

  const addCard = stripeLooksConfigured(me) ? (
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
      size="lg"
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
  );

  const unpairedNote = !paired && objects.length > 0 ? (
    <p className="text-sm leading-relaxed rounded-large-element border border-warning/30 bg-warning/20 text-foreground px-4 py-3">
      These are copies from a Luna that is no longer paired. The monthly bill stays until you turn payment off.
    </p>
  ) : null;

  const filesCard = (
    <BackupFilesCard
      objects={objects}
      note={purging || !me.has_card ? "" : note}
      unpairedNote={unpairedNote}
      paired={paired}
      setError={setError}
    />
  );

  let billingCard;

  if (purging) {
    billingCard = (
      <Card className="animate-fade-in-up" data-testid="backups-purging">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Payment is off</CardTitle>
            <Badge variant="warning">Deleting soon</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm leading-relaxed">
            We still have your cloud copies for {daysLeft === 1 ? "1 more day" : `${daysLeft} more days`}. Download anything you need before they are gone.
          </p>
          <Separator />
          <section className="space-y-3" aria-labelledby="backup-reactivate-heading">
            <h4 id="backup-reactivate-heading" className="font-mono text-xs uppercase tracking-widest">
              Turn payment back on
            </h4>
            <PricingSummary />
            {addCard}
          </section>
          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    );
  } else if (!me.has_card) {
    billingCard = (
      <Card className="animate-fade-in-up" data-testid="backups-gated">
        <CardHeader>
          <CardTitle>Add a payment card</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm leading-relaxed">
            Add a payment card so we can store a cloud backup of your files off-site.
          </p>
          <PricingSummary />
          <Separator />
          {addCard}
          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    );
  } else {
    billingCard = (
      <Card className="animate-fade-in-up" data-testid="backups-open">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Cloud backup</CardTitle>
            <Badge variant="success">Payment on</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <MonthlyCostHighlight amount={me.estimated_month} />
          <PricingSummary />
          <Separator />
          <CancelPaymentSection
            confirmCancel={confirmCancel}
            setConfirmCancel={setConfirmCancel}
            busy={busy}
            onCancel={cancelPayment}
          />
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
