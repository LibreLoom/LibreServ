import { useEffect, useMemo, useState } from "react";
import { HardDrive } from "lucide-react";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Separator } from "../components/ui/separator.jsx";
import { BackupPricingTable } from "../components/BackupPricingTable.jsx";
import { InfoHint } from "../components/ui/Tooltip.jsx";
import { VerifyHumanCard } from "../components/VerifyHumanCard.jsx";
import { UnlockCard } from "../components/cloud/UnlockCard.jsx";
import { CloudBrowser } from "../components/cloud/CloudBrowser.jsx";
import { ShareLinkButton } from "../components/cloud/ShareLinkButton.jsx";
import { ShareLinksCard } from "../components/cloud/ShareLinksCard.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api.js";
import { stripeLooksConfigured } from "../billing/stripeConfig.js";
import { accountSource, listLunas } from "../lib/cloudSource.js";
import { unlockBackups } from "../lib/cloudUnlock.js";
import { userRecordPart } from "@libreloom/ui/lib/cloud/cloudKeys.js";

function daysUntil(unixSeconds) {
  if (!unixSeconds) return null;
  return Math.max(0, Math.ceil((unixSeconds * 1000 - Date.now()) / 86400000));
}

function formatWhen(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
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
      <p id="backup-cost-heading" className="font-mono text-xs">
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
          : "Link a Luna first, then on Luna choose folders or a whole drive to back up."}
      </p>
    </div>
  );
}

function CancelPaymentSection({ confirmCancel, setConfirmCancel, busy, onCancel }) {
  if (!confirmCancel) {
    return (
      <section className="space-y-2" aria-labelledby="backup-actions-heading">
        <h4 id="backup-actions-heading" className="font-mono text-xs">Payment</h4>
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

function LunaPicker({ lunas, chosenId, onChoose }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Choose a Luna">
      {lunas.map((luna) => {
        const selected = luna.luna_id === chosenId;
        return (
          <Button
            key={luna.luna_id}
            type="button"
            size="sm"
            variant={selected ? "default" : "outline"}
            aria-pressed={selected}
            onClick={() => onChoose(luna.luna_id)}
          >
            {luna.name || "Luna"}
          </Button>
        );
      })}
    </div>
  );
}

function BackupFilesCard({ lunas, paired }) {
  const [chosenId, setChosenId] = useState("");
  // Decrypted backups for one Luna. Only shown while that Luna is still the chosen one.
  const [unlocked, setUnlocked] = useState(null);
  // Bumped after a link is created so the links list reloads.
  const [linkRefresh, setLinkRefresh] = useState(0);
  const bump = () => setLinkRefresh((n) => n + 1);

  const chosen = lunas?.find((luna) => luna.luna_id === chosenId) || lunas?.[0] || null;
  const lunaId = chosen?.luna_id || "";
  const source = useMemo(() => (lunaId ? accountSource(lunaId) : null), [lunaId]);
  const backups = unlocked && unlocked.lunaId === lunaId ? unlocked.backups : null;

  function choose(id) {
    setUnlocked(null);
    setChosenId(id);
  }

  async function unlock(words) {
    const result = await unlockBackups(source, words);
    setUnlocked({ lunaId, backups: result.backups });
  }

  let body = null;

  if (lunas && lunas.length === 0) {
    body = <EmptyStorageState paired={paired} />;
  } else if (lunas) {
    const purgeAt = Number(chosen?.purge_after || 0);
    const unpairedNote = chosen && chosen.linked === false ? (
      <p className="text-sm leading-relaxed rounded-large-element border border-warning/30 bg-warning/20 text-foreground px-4 py-3">
        {purgeAt > 0
          ? `These files are from a Luna that is no longer linked. They are deleted on ${formatWhen(purgeAt)} unless you link it again. Download anything you need before then.`
          : "These files are from a Luna that is no longer linked to this account. The monthly bill stays until you turn payment off."}
      </p>
    ) : null;

    body = (
      <>
        {lunas.length > 1 ? <LunaPicker lunas={lunas} chosenId={lunaId} onChoose={choose} /> : null}
        {unpairedNote}
        {backups ? (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setUnlocked(null)}>
                Lock
              </Button>
            </div>
            <CloudBrowser
              source={source}
              backups={backups}
              groupActions={(g) =>
                g.startedBy ? (
                  <ShareLinkButton
                    lunaId={lunaId}
                    scope={{ kind: "user", value: userRecordPart(g.startedBy) }}
                    label={g.name}
                    onCreated={bump}
                  />
                ) : null
              }
              backupActions={(b) => (
                <ShareLinkButton
                  lunaId={lunaId}
                  scope={{ kind: "backup", value: b.protectionId }}
                  label={b.name}
                  onCreated={bump}
                />
              )}
            />
            <ShareLinksCard lunaId={lunaId} backups={backups} refreshKey={linkRefresh} />
          </div>
        ) : (
          <UnlockCard
            description="Type the recovery phrase you wrote down when you turned on cloud backup on Luna."
            onUnlock={unlock}
          />
        )}
      </>
    );
  }

  return (
    <Card className="animate-fade-in-up" data-testid="backups-files">
      <CardHeader>
        <CardTitle>
          Your files
          <InfoHint
            surface="secondary"
            delayMs={0}
            label="About your cloud copies"
            content="Your files are encrypted on Luna before they leave the house. Only your recovery phrase opens them, here in this browser."
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">{body}</CardContent>
    </Card>
  );
}

export function BackupsTab({ me, lunas, paired, onRefresh, setError, error }) {
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

  const filesCard = <BackupFilesCard lunas={lunas} paired={paired} />;

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
            <h4 id="backup-reactivate-heading" className="font-mono text-xs">Turn payment back on</h4>
            <BackupPricingTable />
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
          <BackupPricingTable />
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
          <BackupPricingTable />
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
  const [lunas, setLunas] = useState(null);
  const [paired, setPaired] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!me) return;
    listLunas()
      .then((list) => setLunas(list || []))
      .catch((err) => setError(err.message));
    api("/api/v1/account/devices")
      .then((d) => setPaired((d.devices || []).length > 0))
      .catch(() => {});
  }, [me?.id, me?.has_card, me?.backup_purge_after]);

  return (
    <Layout>
      <h1 className="font-mono text-3xl mb-2">Cloud backups</h1>
      <p className="text-muted-foreground mb-8">A second place for your files if a drive fails or the house is gone.</p>
      <BackupsTab me={me} lunas={lunas} paired={paired} onRefresh={refresh} setError={setError} error={error} />
    </Layout>
  );
}
