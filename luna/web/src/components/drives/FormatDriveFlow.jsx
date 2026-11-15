import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, Circle, Link2Off, Loader2, Lock, PauseCircle, Trash2, Users } from "lucide-react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { getJson, postJson } from "../../lib/api.js";
import { clockSkew, needsFreshPreview, phaseLabel, secondsUntil, startErrorMessage } from "../../lib/driveFormat.js";
import FormatPreview from "./FormatPreview.jsx";

const API = "/api/v1/drive-format";

/** Runs whose "done" toast has already been shown, so reopening never repeats it. */
const announced = new Set();
/** Runs whose failure buzz has already been felt. */
const felt = new Set();

/**
 * The one way Luna erases a drive: look, confirm, erase, done. Nothing else in
 * the app erases anything.
 *
 * Steps: Look (what is on the drive, with the Erase button below it) →
 * Formatting (named steps, safe to close and come back to) → Done or Failed.
 *
 * The look step is the safeguard. When the server can't verify the drive is
 * empty, Erase stays disabled for the server's wait, and the only thing on
 * screen during it is the drive's contents: nothing to fill in, nothing else
 * to do but look. The drive keeps its current name (a drive Luna has keeps
 * its name; a new one takes its volume name or model), so there is no field.
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
      const receivedAt = Date.now();
      setClockMs(receivedAt);
      return { ...result, skew: clockSkew(result.now, receivedAt) };
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

  const looking = !runId && Boolean(preview.data);
  // Redraw while the countdown runs; nothing else needs a clock.
  useEffect(() => {
    if (!looking) return undefined;
    const timer = setInterval(() => setClockMs(Date.now()), 500);
    return () => clearInterval(timer);
  }, [looking]);

  const label = driveLabel(device, preview.data);

  const lookAgain = () => {
    setAttempt((n) => n + 1);
    setRunId(null);
    setStartError(null);
    setReady(null);
  };

  const start = async () => {
    if (!preview.data) return;
    setStarting(true);
    setStartError(null);
    try {
      const body = { preview_id: preview.data.preview_id, label };
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

  const lost = run.isError && /** @type {any} */ (run.error)?.status === 404;
  let title = "Erase this drive?";
  if (runId) title = status?.done ? "Drive is ready" : status?.failed ? "The erase didn't finish" : "Erasing this drive";

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
          ) : (
            <LookStep
              preview={preview.data}
              password={password}
              starting={starting}
              error={startError}
              ready={ready}
              clockMs={clockMs}
              onErase={start}
              onLookAgain={lookAgain}
              onCancel={close}
            />
          )}
        </div>
      )}
    </ModalCard>
  );
}

/**
 * The name the erased drive gets: the one it already has in Luna, else the
 * name its first part carries, else its model.
 */
function driveLabel(device, preview) {
  const firstPart = preview?.partitions?.find((p) => p.label)?.label;
  return (device.label || firstPart || device.model || preview?.device?.model || "Drive").trim().slice(0, 80);
}

function LookStep({ preview, password, starting, error, ready, clockMs, onErase, onLookAgain, onCancel }) {
  const clientNow = clockMs;
  const readyAt = ready?.readyAt ?? preview.ready_at;
  const skew = ready?.skew ?? preview.skew;
  const seconds = secondsUntil(readyAt, skew, clientNow);
  const expired = clientNow / 1000 + skew >= preview.expires_at;
  const cantProtect = Boolean(password) && preview.can_encrypt === false;
  const registered = Boolean(preview.registered_drive_id);
  const waiting = seconds > 0 && !expired;
  const canErase = seconds === 0 && !expired && !cantProtect;
  return (
    <>
      <FormatPreview preview={preview} />
      <div>
        <h3 className="mb-2 font-mono text-sm">What happens</h3>
        <ul className="space-y-2" aria-label="What happens">
          <Outcome icon={preview.empty ? CheckCircle2 : Trash2}>
            {preview.empty ? "Nothing on it is lost." : "Everything on it is erased. You can't undo this."}
          </Outcome>
          {registered && <Outcome icon={Link2Off}>Share links and access to single files, folders, and albums are removed.</Outcome>}
          {registered && <Outcome icon={Users}>People with access to the whole drive keep it.</Outcome>}
          {registered && <Outcome icon={PauseCircle}>Backups to or from this drive stop until you set them up again.</Outcome>}
          {/* The caller that collected the password already said it can't be recovered. */}
          {password && !cantProtect && <Outcome icon={Lock}>Luna protects the drive with your password.</Outcome>}
        </ul>
      </div>
      {cantProtect && <InlineError>This is a test drive made from a folder. A folder can&apos;t be protected with a password.</InlineError>}
      {expired && !error && <InlineError>Luna&apos;s look at this drive is out of date. Look at the drive again.</InlineError>}
      {error && <InlineError>{error.message}</InlineError>}
      <div className="flex flex-wrap gap-3">
        {expired || error?.fresh ? (
          <Button onClick={onLookAgain}>Look at the drive again</Button>
        ) : (
          <Button variant="danger" disabled={!canErase} loading={starting} onClick={onErase}>
            {waiting ? `Erase drive (${seconds})` : "Erase drive"}
          </Button>
        )}
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </>
  );
}

/** One line of "What happens": an icon, then one short sentence. */
function Outcome({ icon: Icon, children }) {
  return (
    <li className="flex items-start gap-3 text-sm">
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </li>
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
        <p className="text-sm">Look at the drive again, then try again.</p>
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
      {unreachable && <p className="text-sm" role="status">Can&apos;t get the erase progress right now. Still trying.</p>}
      <p className="text-sm">
        Don&apos;t unplug the drive. You can close this window: Luna keeps going, and Files shows where it is.
      </p>
      <Button variant="outline" onClick={onClose}>Close</Button>
    </>
  );
}
