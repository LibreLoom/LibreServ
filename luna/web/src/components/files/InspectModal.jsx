import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { InfoHint, TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { apiErrorMessage, postJson } from "../../lib/api.js";
import { ROOT_TERM_HINT } from "../../lib/rootTerm.js";
import { describeInspectSummary } from "../../lib/fileCounts.js";
export default function InspectModal({
  open = true,
  drive,
  result,
  error,
  onClose,
  onAdopt,
  onFormat,
  adoptError,
  adopting
}) {
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const client = useQueryClient();
  const { addToast } = useToast();
  useEffect(() => {
    if (open && drive) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seed the draft for each inspected drive
      setLabel(drive.model || "My drive"); setPassword(""); setUnlockError("");
    }
  }, [open, drive]);
  return <ModalCard open={open} onClose={onClose} title={<span className="inline-flex items-center gap-2 flex-wrap">{`Add ${drive?.model || drive?.name || "drive"}`}<InfoHint label="What happens when you add a drive" content="Luna shows what's on the drive first. Nothing is changed until you confirm." /></span>}>
    {({
      close
    }) => <div className="space-y-4">
      {!result && !error && <p role="status">Checking the drive…</p>}
      {error && <InlineError>{error}</InlineError>}
      {result && <>
        <p className="text-sm">{result.locked ? "This drive is encrypted and locked." : describeInspectSummary(result)}</p>
        {result.entries?.length > 0 && <div className="surface-primary rounded-large-element p-4"><p className="font-mono text-sm">On this drive</p><ul className="mt-2 space-y-1">{result.entries.map(entry => <li key={`${entry.kind}:${entry.name}`}><InlinePill>{entry.name}</InlinePill></li>)}</ul>{Number(result.files) + Number(result.folders) > result.entries.length && <p className="text-secondary text-xs mt-2">Showing items at the <TermHint content={ROOT_TERM_HINT} surface="primary">root</TermHint> of the drive.</p>}</div>}
        {result.locked ? <>
          <form className="surface-primary rounded-large-element p-4 space-y-3" onSubmit={async (event) => {
            event.preventDefault(); setUnlockError(""); setUnlocking(true);
            try {
              await postJson(`/api/v1/drives/${encodeURIComponent(drive.name)}/unlock-and-add`, { password });
              setPassword(""); await Promise.all([client.invalidateQueries({ queryKey: ["drives"] }), client.invalidateQueries({ queryKey: ["drives-detected"] })]);
              addToast({ type: "success", message: "Drive unlocked and added." }); close();
            } catch (err) { haptic("error"); setUnlockError(apiErrorMessage(err, "Could not unlock and add this drive.")); }
            finally { setUnlocking(false); }
          }}>
            <p className="text-sm">Enter its password to add it and keep its files.</p>
            <label className="block text-sm">Drive password<input className="mt-2 w-full rounded-pill surface-secondary border-2 border-primary/30 px-4 py-2 text-sm focus:border-accent" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            {unlockError && <InlineError>{unlockError}</InlineError>}
            <Button type="submit" variant="secondary" loading={unlocking}>Unlock and add</Button>
          </form>
          <p className="text-sm">Formatting erases all files and partitions on the whole drive.</p>
          <Button variant="outline" onClick={() => onFormat(drive)}>Format drive</Button>
        </> : result.readable && result.writable && !result.needs_erase ? <>
          <div className="flex items-center gap-3">
            <Info size={18} className="shrink-0" aria-hidden="true" />
            <p className="text-sm">Adding it writes a <InlinePill>.luna</InlinePill> database file at the <TermHint content={ROOT_TERM_HINT}>root</TermHint> of the drive. Your files are untouched.</p>
          </div>
          <label className="block text-sm">Drive name<input className="mt-2 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm no-focus-outline focus:border-accent" value={label} maxLength={80} placeholder="e.g. Photos drive" onChange={e => setLabel(e.target.value)} /></label>
          {adoptError && <InlineError>{adoptError}</InlineError>}
          <Button loading={adopting} onClick={() => Promise.resolve(onAdopt(label, false)).then(close).catch(() => {})}>Add this drive</Button>
        </> : <><p className="text-sm">Format this drive to use it with Luna. Formatting erases all files and partitions on the whole drive.</p><Button variant="accent" haptic="warning" onClick={() => onFormat(drive)}>Format drive</Button></>}
      </>}
    </div>}
  </ModalCard>;
}
