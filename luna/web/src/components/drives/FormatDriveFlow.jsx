import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Circle, Loader2 } from "lucide-react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { getJson, postJson } from "../../lib/api.js";
import { clockSkew, needsFreshPreview, phaseLabel, secondsUntil, startErrorMessage } from "../../lib/driveFormat.js";
import { formatBytes } from "../../lib/formatBytes.js";
import FormatPreview from "./FormatPreview.jsx";

const API = "/api/v1/drive-format";
const FIELD = "mt-2 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm no-focus-outline focus:border-accent";

/** Runs whose "done" toast has already been shown, so reopening never repeats it. */
const announced = new Set();
/** Runs whose failure buzz has already been felt. */
const felt = new Set();

/**
 * The one way Luna erases a drive: look, confirm, erase, done. Nothing else in
 * the app erases anything.
 *
 * Steps: Preview (what is on the drive) → Confirm (name it, wait out the
 * countdown if the drive isn't verified empty) → Formatting (named steps,
 * safe to close and come back to) → Done or Failed.
 *
 * The caller decides whether the drive is protected with a password: passing
 * `password` makes an encrypted drive, passing none makes a plain one. There
 * is no way to choose here. The password is only ever sent in the start
 * request; it is kept out of query keys and state.
 *
 * @param {{
 *   device: { name: string, model?: string, label?: string, format_id?: string | null },
 *   password?: string,
 *   open?: boolean,
 *   onDone: (driveId: string) => void,
 *   onCancel: () => void,
 * }} props
 *   `device.name` is the disk's kernel name (`sdb`), as the drive lists send it.
 *   `device.format_id` reopens a run already in progress. `onCancel` fires after
 *   the window has closed, whatever step it was on. `onDone` gets the drive's
 *   id when the person chooses Open drive.
 */
export default function FormatDriveFlow({ device, password, open = true, onDone, onCancel }) {
  const client = useQueryClient();
  const { addToast } = useToast();
  const [attempt, setAttempt] = useState(0);
  const [runId, setRunId] = useState(device.format_id || null);
  const [confirming, setConfirming] = useState(false);
  const [label, setLabel] = useState(device.label || device.model || "My drive");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(/** @type {{ message: string, fresh: boolean } | null} */ (null));
  const [ready, setReady] = useState(/** @type {{ readyAt: number, skew: number } | null} */ (null));
  // The browser's clock as of the last redraw; the countdown is worked out from it.
  const [clockMs, setClockMs] = useState(() => Date.now());

  const preview = useQuery({
    queryKey: ["drive-format-preview", device.name, attempt],
    enabled: !runId,
    queryFn: async () => {
      const result = await postJson(`${API}/preview`, { device: device.name });
      // Counted on the server's clock: how far it is from ours, right now.
      return { ...result, skew: clockSkew(result.now) };
    },
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const run = useQuery({
    queryKey: ["drive-format-run", runId],
    enabled: Boolean(runId),
    queryFn: () => getJson(`${API}/${encodeURIComponent(String(runId))}`),
    refetchInterval: (query) => (query.state.data?.done || query.state.data?.failed ? false : 1000),
    // A dropped connection is not the end of an erase: keep asking. Only
    // "Luna has no record of it" is final.
    retry: (_count, err) => /** @type {any} */ (err)?.status !== 404,
    retryDelay: 1500,
  });
  const status = run.data;

  // Done: say so once, and make every list that shows this drive look again.
  useEffect(() => {
    if (!status?.done || announced.has(status.id)) return;
    announced.add(status.id);
    addToast({ type: "success", message: "Drive erased and set up." });
    client.invalidateQueries({ queryKey: ["drives"] });
    client.invalidateQueries({ queryKey: ["drives-detected"] });
    client.invalidateQueries({ queryKey: ["drive-peek"] });
  }, [status, addToast, client]);

  // Failed: one buzz, on the change to failed. The window owns the message.
  useEffect(() => {
    if (!status?.failed || felt.has(status.id)) return;
    felt.add(status.id);
    haptic("error");
    client.invalidateQueries({ queryKey: ["drives"] });
    client.invalidateQueries({ queryKey: ["drives-detected"] });
  }, [status, client]);

  const confirmStep = !runId && confirming && Boolean(preview.data);
  // Redraw while the countdown runs; nothing else needs a clock.
  useEffect(() => {
    if (!confirmStep) return undefined;
    const timer = setInterval(() => setClockMs(Date.now()), 500);
    return () => clearInterval(timer);
  }, [confirmStep]);

  const lookAgain = () => {
    setAttempt((n) => n + 1);
    setRunId(null);
    setConfirming(false);
    setStartError(null);
    setReady(null);
  };

  const start = async () => {
    if (!preview.data) return;
    setStarting(true);
    setStartError(null);
    try {
      const body = { preview_id: preview.data.preview_id, label: label.trim() };
      const first = await postJson(`${API}/start`, password ? { ...body, password } : body);
      client.setQueryData(["drive-format-run", first.id], first);
      setRunId(first.id);
      client.invalidateQueries({ queryKey: ["drives"] });
      client.invalidateQueries({ queryKey: ["drives-detected"] });
    } catch (err) {
      const e = /** @type {any} */ (err);
      // The server says exactly when the wait ends: take its word over ours.
      if (e?.code === "format_not_ready" && typeof e.data?.ready_at === "number") {
        setReady({ readyAt: e.data.ready_at, skew: clockSkew(e.data.now) });
      }
      haptic("error");
      setStartError({
        message: startErrorMessage(e, "Luna couldn't start erasing this drive. Try again."),
        fresh: needsFreshPreview(e),
      });
    } finally {
      setStarting(false);
    }
  };

  const name = device.model || device.label || device.name;
  const lost = run.isError && /** @type {any} */ (run.error)?.status === 404;
  let title = "What's on this drive";
  if (runId) title = status?.done ? "Drive is ready" : status?.failed ? "The erase didn't finish" : "Erasing this drive";
  else if (confirmStep) title = "Erase this drive?";

  return (
    <ModalCard open={open} onClose={onCancel} title={title}>
      {({ close }) => (
        <div className="space-y-4">
          {runId ? (
            <RunStep
              status={status}
              lost={lost}
              unreachable={!lost && run.failureCount > 0}
              label={label}
              onLookAgain={lookAgain}
              onOpen={() => onDone(status.drive_id)}
              onClose={close}
            />
          ) : preview.isPending ? (
            <p role="status">Looking at the drive…</p>
          ) : preview.isError ? (
            <>
              <InlineError>{startErrorMessage(preview.error, "Luna couldn't look at this drive. Make sure it's plugged in and try again.")}</InlineError>
              <div className="flex gap-3">
                <Button onClick={lookAgain}>Try again</Button>
                <Button variant="outline" onClick={close}>Close</Button>
              </div>
            </>
          ) : confirming ? (
            <ConfirmStep
              preview={preview.data}
              name={preview.data.device?.model || name}
              label={label}
              onLabel={setLabel}
              password={password}
              starting={starting}
              error={startError}
              ready={ready}
              clockMs={clockMs}
              onBack={() => { setConfirming(false); setStartError(null); }}
              onErase={start}
              onLookAgain={lookAgain}
            />
          ) : (
            <>
              <FormatPreview preview={preview.data} />
              <div className="flex gap-3">
                <Button onClick={() => { setClockMs(Date.now()); setConfirming(true); }}>Continue</Button>
                <Button variant="outline" onClick={close}>Cancel</Button>
              </div>
            </>
          )}
        </div>
      )}
    </ModalCard>
  );
}

function ConfirmStep({ preview, name, label, onLabel, password, starting, error, ready, clockMs, onBack, onErase, onLookAgain }) {
  const clientNow = clockMs;
  const readyAt = ready?.readyAt ?? preview.ready_at;
  const skew = ready?.skew ?? preview.skew;
  const seconds = secondsUntil(readyAt, skew, clientNow);
  const expired = clientNow / 1000 + skew >= preview.expires_at;
  const cantProtect = Boolean(password) && preview.can_encrypt === false;
  const registered = Boolean(preview.registered_drive_id);
  const waiting = seconds > 0 && !expired;
  const canErase = seconds === 0 && !expired && !cantProtect && label.trim().length > 0;
  return (
    <>
      {preview.empty ? (
        <p className="text-sm"><InlinePill>{name}</InlinePill> has nothing on it, so there is nothing to lose.</p>
      ) : (
        <p className="text-sm">
          Everything on <InlinePill>{name}</InlinePill>
          {preview.device?.size_bytes ? ` (${formatBytes(preview.device.size_bytes)})` : ""} will be erased. This can&apos;t be undone.
        </p>
      )}
      {registered && (
        <p className="text-sm">
          This drive is already added to Luna. People with access to the whole drive keep it. Share links and
          folder-by-folder access are removed, and this drive&apos;s backups stop until you set them up again.
        </p>
      )}
      {password ? (
        <p className="text-sm">
          The drive will be protected with the password you chose. There is no way to recover it: if it&apos;s lost,
          the files on the drive are lost too.
        </p>
      ) : (
        <p className="text-sm">Luna will set it up as one drive that Windows, Mac, and Linux computers can open.</p>
      )}
      <label className="block text-sm">
        Drive name
        <input
          className={FIELD}
          value={label}
          maxLength={80}
          placeholder="e.g. Photos drive"
          onChange={(e) => onLabel(e.target.value)}
        />
      </label>
      {cantProtect && <InlineError>Password protection isn&apos;t available for this drive.</InlineError>}
      {expired && !error && <InlineError>Luna&apos;s look at this drive is out of date. Look at the drive again.</InlineError>}
      {error && <InlineError>{error.message}</InlineError>}
      {waiting && (
        <p className="text-sm" role="timer">
          You can erase this drive in {seconds} {seconds === 1 ? "second" : "seconds"}. The pause gives you time to check it&apos;s the right drive.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {expired || error?.fresh ? (
          <Button onClick={onLookAgain}>Look at the drive again</Button>
        ) : (
          <Button variant="danger" disabled={!canErase} loading={starting} onClick={onErase}>
            {waiting ? `Erase drive (${seconds})` : "Erase drive"}
          </Button>
        )}
        <Button variant="outline" onClick={onBack}>Back</Button>
      </div>
    </>
  );
}

function RunStep({ status, lost, unreachable, label, onLookAgain, onOpen, onClose }) {
  if (lost) {
    return (
      <>
        <p className="text-sm">
          Luna lost track of this erase, probably because it restarted. Look at the drive again to see where it stands.
        </p>
        <div className="flex gap-3">
          <Button onClick={onLookAgain}>Look at the drive again</Button>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </>
    );
  }
  if (!status) return <p role="status">Checking where the erase is…</p>;

  if (status.done) {
    return (
      <>
        <p className="text-sm">
          {label ? <><InlinePill>{label}</InlinePill> is</> : "The drive is"} ready to use.
        </p>
        <div className="flex gap-3">
          <Button onClick={onOpen}>Open drive</Button>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </>
    );
  }

  if (status.failed) {
    return (
      <>
        <InlineError>{status.error || "Luna couldn't finish erasing this drive."}</InlineError>
        <p className="text-sm">
          {status.erased
            ? "The old files may already be gone from this drive."
            : "Nothing was erased. The drive is as it was."}
        </p>
        <p className="text-sm">Check that the drive is plugged in, then look at it again and try once more.</p>
        <div className="flex gap-3">
          <Button onClick={onLookAgain}>Look at the drive again</Button>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </>
    );
  }

  const at = status.phases.indexOf(status.phase);
  return (
    <>
      <ol className="space-y-2" aria-label="Erase progress">
        {status.phases.map((phase, i) => {
          const finished = i < at;
          const current = i === at;
          return (
            <li key={phase} className="flex items-center gap-3 text-sm" aria-current={current ? "step" : undefined}>
              {finished
                ? <Check size={16} className="shrink-0" aria-hidden="true" />
                : current
                  ? <Loader2 size={16} className="shrink-0 motion-safe:animate-spin" aria-hidden="true" />
                  : <Circle size={16} className="shrink-0" aria-hidden="true" />}
              <span className={current ? "font-mono" : ""}>{phaseLabel(phase)}</span>
            </li>
          );
        })}
      </ol>
      {unreachable && <p className="text-sm" role="status">Can&apos;t reach Luna right now. Still trying.</p>}
      <p className="text-sm">
        Don&apos;t unplug the drive. You can close this window: Luna keeps going, and Files shows where it is.
      </p>
      <Button variant="outline" onClick={onClose}>Close</Button>
    </>
  );
}
