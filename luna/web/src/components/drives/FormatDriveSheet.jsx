import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { apiErrorMessage, getJson, postJson } from "../../lib/api.js";
import { formatBytes } from "../../lib/formatBytes.js";
import { announceFormat } from "../../lib/formatNotifications.js";
const base = "/api/v1/drive-format";
const field = "mt-2 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm focus:border-accent";
const fieldOnPrimary = "mt-2 w-full rounded-pill surface-secondary border-2 border-primary/30 px-4 py-2 text-sm focus:border-accent";
const terminal = op => op && ["succeeded", "failed", "interrupted"].includes(op.state);
export default function FormatDriveSheet({
  drive,
  open,
  onClose,
  initialEncrypted = false
}) {
  const client = useQueryClient();
  const {
    addToast
  } = useToast();
  const [label, setLabel] = useState("");
  const [filesystem, setFilesystem] = useState("");
  const [encrypted, setEncrypted] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [plan, setPlan] = useState(null);
  const [operation, setOperation] = useState(null);
  const [dismissed, setDismissed] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [startUncertain, setStartUncertain] = useState(false);
  const [statusChecked, setStatusChecked] = useState(false);
  const [reviewFailed, setReviewFailed] = useState(false);
  const [reviewAttempt, setReviewAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const observedRunning = useRef(new Set());
  const device = drive?.device || drive?.name || "";
  const identity = drive?.id ? `drive_id=${encodeURIComponent(drive.id)}` : `device=${encodeURIComponent(device)}`;
  const capabilities = useQuery({
    queryKey: ["format-capabilities"],
    queryFn: () => getJson(`${base}/capabilities`),
    enabled: open
  });
  const operations = useQuery({
    queryKey: ["format-operations", identity],
    queryFn: () => getJson(`${base}/operations?${identity}`),
    enabled: !!drive && (open || Boolean(operation && !terminal(operation))),
    refetchInterval: q => q.state.data?.operations?.some(op => !terminal(op)) ? 1500 : false
  });
  useEffect(() => {
    if (open && drive) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seed the draft when a drive opens
      setLabel(drive.label || drive.model || "My drive");
      setFilesystem("");
      setEncrypted(initialEncrypted);
      setPassword("");
      setConfirm("");
      setPlan(null);
      setOperation(null);
      setDismissed("");
      setStartUncertain(false);
      setStatusChecked(false);
      setReviewFailed(false);
      setError("");
    }
  }, [open, drive, initialEncrypted]);
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- discard secrets when the sheet closes
      setPassword("");
      setConfirm("");
    }
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  const current = operation ? operations.data?.operations?.find(op => op.id === operation.id) || operation : operations.data?.operations?.[0]?.id === dismissed ? null : operations.data?.operations?.[0];
  useEffect(() => {
    if (current && terminal(current)) {
      client.invalidateQueries({
        queryKey: ["drives"]
      });
      client.invalidateQueries({
        queryKey: ["drives-detected"]
      });
    }
  }, [current, client]);
  useEffect(() => {
    if (!current) return;
    if (!terminal(current)) observedRunning.current.add(current.id);else if (observedRunning.current.has(current.id)) announceFormat(current, addToast);
  }, [current, addToast]);
  // Review starts only after React has displayed the returned contents.
  useEffect(() => {
    if (!plan || plan.review_ready_at || !open) return;
    let active = true;
    let secondFrame;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        postJson(`${base}/plans/${plan.id}/review`, {}).then(value => {
          if (active) setPlan(value);
        }).catch(err => {
          if (active) {
            haptic("error");
            setReviewFailed(true);
            setError(apiErrorMessage(err, "Could not start the review."));
          }
        });
      });
    });
    return () => {
      active = false;
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [plan, open, reviewAttempt]);
  const filesystems = capabilities.data?.filesystems || [];
  useEffect(() => {
    if (open && initialEncrypted && !filesystem && capabilities.data) {
      const option = capabilities.data.filesystems.find(fs => fs.encryption_supported && fs.available !== false && fs.encryption_available !== false);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- use an advertised encryption format for this handoff
      if (option) setFilesystem(option.id);
    }
  }, [open, initialEncrypted, filesystem, capabilities.data]);
  const selected = filesystems.find(fs => fs.id === filesystem);
  const encryptionOptions = filesystems.some(fs => fs.encryption_supported && fs.available !== false && fs.encryption_available !== false);
  const wait = plan?.review_ready_at ? Math.max(0, Math.ceil(plan.review_ready_at - now / 1000)) : null;
  const createPlan = async () => {
    if (encrypted && (!password || password !== confirm)) {
      setError("The passwords must match.");
      haptic("error");
      return;
    }
    setError("");
    setBusy(true);
    try {
      setReviewFailed(false);
      setPlan(await postJson(`${base}/plans`, {
        ...(drive.id ? {
          drive_id: drive.id
        } : {
          device
        }),
        label,
        filesystem,
        encrypted,
        scope: "drive"
      }));
    } catch (err) {
      haptic("error");
      setError(apiErrorMessage(err, "Could not inspect this drive for formatting."));
    } finally {
      setBusy(false);
    }
  };
  const checkStart = async () => {
    const result = await operations.refetch();
    if (result.isError) {
      setError("Could not check whether formatting started. Check the status again.");
      return;
    }
    const found = result.data?.operations?.find(op => op.plan_id === plan?.id);
    if (found) {
      if (!terminal(found)) observedRunning.current.add(found.id);
      setOperation(found);
      setStartUncertain(false);
      setError("");
    } else {
      setStatusChecked(true);
      setError("No format was found for this review. Inspect the drive again before formatting.");
    }
  };
  const start = async () => {
    if (encrypted && (!password || password !== confirm)) {
      setError("The passwords must match.");
      haptic("error");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const op = await postJson(`${base}/plans/${plan.id}/start`, encrypted ? {
        password
      } : {});
      observedRunning.current.add(op.id);
      setOperation(op);
      setPassword("");
      setConfirm("");
      void operations.refetch();
    } catch (err) {
      haptic("error");
      setStartUncertain(true);
      setError(apiErrorMessage(err, "Could not confirm whether formatting started. Checking its status."));
      await checkStart();
    } finally {
      setBusy(false);
    }
  };
  return <ModalCard open={open} onClose={onClose} title="Format drive">
    {() => <div className="space-y-4">
      <FormatSteps step={current ? terminal(current) ? 3 : 2 : plan ? 1 : 0} />
      {drive && <div className="surface-primary rounded-large-element p-4 space-y-2">
        <h3 className="font-mono text-base">{drive.model || drive.label || drive.name}</h3>
        <p className="text-sm">{drive.label && <InlinePill>{drive.label}</InlinePill>}{drive.size_bytes ? <> · {formatBytes(drive.size_bytes)}</> : null}{device && <> · <InlinePill>{device}</InlinePill></>}</p>
      </div>}
      {operations.isLoading && <p role="status">Checking for a format already in progress…</p>}
      {operations.isError && <><InlineError>Could not check this drive's format status.</InlineError><Button variant="outline" onClick={() => operations.refetch()}>Try again</Button></>}
      {!operations.isLoading && !operations.isError && current && <div className="surface-primary rounded-large-element p-4 space-y-2" role="status">
        <h3 className="font-mono text-base">{current.state === "succeeded" ? "Format complete" : current.state === "failed" ? "Format failed" : current.state === "interrupted" ? "Format interrupted" : "Formatting"}</h3>
        <FormatProgress operation={current} />
        {current.error && <InlineError>{current.error}</InlineError>}
        {current.state === "succeeded" && <p className="text-sm">{current.encrypted ? "The encrypted drive is unlocked and ready to use." : "The drive is ready to use."}</p>}
        {(current.state === "failed" || current.state === "interrupted") && <p className="text-sm">{current.destructive_started ? "Formatting had started; the drive's contents may have changed." : "Formatting did not begin erasing the drive."} Inspect the drive again before taking another action.</p>}
        {terminal(current) && <Button variant="outline" surface="primary" onClick={() => {
          setDismissed(current.id);
          setOperation(null);
          setPlan(null);
          setError("");
        }}>Inspect drive again</Button>}
      </div>}
      {!operations.isLoading && !operations.isError && !current && <>
        {capabilities.isLoading && <p role="status">Checking available formats…</p>}
        {capabilities.isError && <><InlineError>Could not load available formats.</InlineError><Button variant="outline" onClick={() => capabilities.refetch()}>Try again</Button></>}
        {capabilities.data && !plan && <>
          {filesystems.length === 0 && <InlineError>No drive formats are available on this Luna.</InlineError>}
          {filesystems.length > 0 && filesystems.every(fs => fs.available === false) && <InlineError>{filesystems[0].unavailable_reason || "No drive formats are available on this Luna."}</InlineError>}
          {initialEncrypted && !encryptionOptions && <InlineError>Encryption is not available on this Luna.</InlineError>}
          <p className="text-sm">Formatting erases all files and all partitions on the whole drive.</p>
          <label className="block text-sm">Drive name<input className={field} value={label} maxLength={80} onChange={e => setLabel(e.target.value)} /></label>
          <label className="block text-sm">Format<select className={field} value={filesystem} onChange={e => {
              setFilesystem(e.target.value);
              const option = filesystems.find(fs => fs.id === e.target.value);
              if (!option?.encryption_supported || option.encryption_available === false) setEncrypted(false);
            }}><option value="">Choose a format</option>{filesystems.map(fs => <option key={fs.id} value={fs.id} disabled={fs.available === false}>{fs.label}{fs.available === false ? ` — ${fs.unavailable_reason || "Unavailable"}` : ""}</option>)}</select></label>
          {selected && <p className="text-sm">{selected.description}</p>}
          {selected?.encryption_supported && selected.encryption_available === false && <p className="text-sm">Encryption is not available on this Luna.</p>}
          {selected?.encryption_supported && <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={selected.encryption_available === false} checked={encrypted && selected.encryption_available !== false} onChange={e => {
              haptic("selection");
              setEncrypted(e.target.checked);
            }} /> Encrypt this drive with a password</label>}
          {encrypted && selected?.encryption_supported && selected.encryption_available !== false && <div className="surface-primary rounded-large-element p-4 space-y-3">
            <p className="text-sm">If you forget this password, the files cannot be recovered.</p>
            <label className="block text-sm">Drive password<input className={fieldOnPrimary} type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
            <label className="block text-sm">Confirm password<input className={fieldOnPrimary} type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
          </div>}
          <Button disabled={!label.trim() || !selected || selected.available === false || (encrypted && (!selected.encryption_supported || selected.encryption_available === false))} loading={busy} onClick={createPlan}>Review drive</Button>
        </>}
        {plan && <>
          <p className="text-sm">Formatting erases the whole drive, including all partitions and files.</p>
          <div className="surface-primary rounded-large-element p-4 space-y-3"><h3 className="font-mono text-base">Review what will be erased</h3><p className="text-sm">Contents shown when checked; all files are erased.</p><p className="text-sm">{plan.model && <><InlinePill>{plan.model}</InlinePill> · </>}<InlinePill>{drive?.label || drive?.name}</InlinePill> · {formatBytes(plan.size_bytes)} · <InlinePill>{plan.device}</InlinePill></p>
            {plan.partitions.length === 0 && <p className="text-sm">No partitions found.</p>}
            {plan.partitions.map(part => <div key={part.device} className="surface-secondary rounded-large-element p-3"><p className="font-mono text-sm">{part.label || part.device} · {formatBytes(part.size_bytes)}</p><p className="text-sm">{part.readable ? `${part.files} files, ${part.folders} folders` : "Luna could not read this partition."}</p>{part.entries?.length > 0 && <ul className="text-sm mt-2">{part.entries.map(entry => <li key={`${entry.kind}:${entry.name}`}><InlinePill>{entry.name}</InlinePill></li>)}</ul>}</div>)}
            {plan.consequences.map(item => <p className="text-sm" key={item}>{item}</p>)}
          </div>
          <p className="text-sm">New format: <InlinePill>{plan.filesystem}</InlinePill> · {plan.encrypted ? "Encrypted" : "Not encrypted"}</p>
          <p className="text-sm">{wait === null ? reviewFailed ? "Review could not start." : "Starting review…" : wait > 0 ? `Review the drive for ${wait} more seconds.` : "Review complete. Formatting will erase all partitions and files."}</p>
          {reviewFailed && <Button variant="outline" onClick={() => { setError(""); setReviewFailed(false); setReviewAttempt(value => value + 1); }}>Try review again</Button>}
          <div className="flex gap-2 flex-wrap">{startUncertain ? <>{!statusChecked && <Button variant="outline" loading={busy} onClick={checkStart}>Check format status</Button>}{statusChecked && <Button variant="outline" onClick={() => {
                setPlan(null);
                setStartUncertain(false);
                setStatusChecked(false);
                setError("");
              }}>Inspect drive again</Button>}</> : <><Button variant="accent" haptic="warning" disabled={wait === null || wait > 0} loading={busy} onClick={start}>Format and erase</Button><Button variant="outline" onClick={() => {
                setPlan(null);
                setPassword("");
                setConfirm("");
                setReviewFailed(false);
                setError("");
              }}>Change options</Button></>}</div>
        </>}
      </>}
      {error && <InlineError>{error}</InlineError>}
    </div>}
  </ModalCard>;
}
function FormatSteps({
  step
}) {
  return <ol aria-label="Format steps" className="flex flex-wrap gap-2">
    {["Choose", "Review", "Format", "Result"].map((name, index) => <li key={name} aria-current={index === step ? "step" : undefined} className={`rounded-pill px-3 py-1 text-xs transition-colors ${index === step ? "surface-primary" : "surface-secondary border border-primary/30"}`}>{name}</li>)}
  </ol>;
}
function FormatProgress({
  operation
}) {
  return <div className="surface-secondary rounded-large-element p-3 motion-safe:transition-all"><p className="text-xs font-mono">Current step</p><p className="text-sm mt-1">{operation.phase}</p></div>;
}
