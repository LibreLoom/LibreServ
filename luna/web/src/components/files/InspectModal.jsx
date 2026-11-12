import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { InfoHint, TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { ROOT_TERM_HINT } from "../../lib/rootTerm.js";
import { describeInspectSummary } from "../../lib/fileCounts.js";
export default function InspectModal({
  open = true,
  drive,
  result,
  error,
  onClose,
  onAdopt,
  adoptError,
  adopting
}) {
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (open && drive) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seed the draft for each inspected drive
      setLabel(drive.model || "My drive");
    }
  }, [open, drive]);
  return <ModalCard open={open} onClose={onClose} title={<span className="inline-flex items-center gap-2 flex-wrap">{`Add ${drive?.model || drive?.name || "drive"}`}<InfoHint label="What happens when you add a drive" content="Luna shows what's on the drive first. Nothing is changed until you confirm." /></span>}>
    {({
      close
    }) => <div className="space-y-4">
      {!result && !error && <p role="status">Checking the drive…</p>}
      {error && <InlineError>{error}</InlineError>}
      {result && <>
        {!result.encrypted && !result.needs_setup && <p className="text-sm">{describeInspectSummary(result)}</p>}
        {result.entries?.length > 0 && <div className="surface-primary rounded-large-element p-4"><p className="font-mono text-sm">On this drive</p><ul className="mt-2 space-y-1">{result.entries.map(entry => <li key={`${entry.kind}:${entry.name}`}><InlinePill>{entry.name}</InlinePill></li>)}</ul>{Number(result.files) + Number(result.folders) > result.entries.length && <p className="text-secondary text-xs mt-2">Showing items at the <TermHint content={ROOT_TERM_HINT} surface="primary">root</TermHint> of the drive.</p>}</div>}
        {result.encrypted ? <p className="text-sm">Luna can't open encrypted drives in this version yet.</p> : result.needs_setup ? <p className="text-sm">Setting up new drives isn't available in this version yet.</p> : result.readable && result.writable ? <>
          <div className="flex items-center gap-3">
            <Info size={18} className="shrink-0" aria-hidden="true" />
            <p className="text-sm">Adding it writes a <InlinePill>.luna</InlinePill> database file at the <TermHint content={ROOT_TERM_HINT}>root</TermHint> of the drive. Your files are untouched.</p>
          </div>
          <label className="block text-sm">Drive name<input className="mt-2 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm no-focus-outline focus:border-accent" value={label} maxLength={80} placeholder="e.g. Photos drive" onChange={e => setLabel(e.target.value)} /></label>
          {adoptError && <InlineError>{adoptError}</InlineError>}
          <Button loading={adopting} onClick={() => Promise.resolve(onAdopt(label)).then(close).catch(() => {})}>Add this drive</Button>
        </> : <p className="text-sm">Luna can't save files to this drive right now. If it has a lock switch, slide it to unlock, then try again.</p>}
      </>}
    </div>}
  </ModalCard>;
}
